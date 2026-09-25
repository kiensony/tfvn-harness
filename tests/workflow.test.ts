import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  Controller,
  baselineTestPaths,
  parseJson,
  validateGraph,
  runGraph,
} from "../packages/core/src/controller.js";
import { Journal } from "../packages/core/src/journal.js";
import { ArtifactStore } from "../packages/core/src/artifacts.js";
import { loadConfig } from "../packages/core/src/config.js";
import {
  type ModelAdapter,
  type ModelRequest,
  type ModelEvent,
} from "../packages/core/src/model.js";
import { runProcess } from "../packages/core/src/process.js";
import { type Sandbox } from "../packages/core/src/sandbox.js";

test("parseJson accepts one fenced object and rejects two documents", () => {
  const plan = {
    criteria: [{ id: "AC1", text: "Correct sum" }],
    tasks: [
      {
        id: "dev",
        department: "dev",
        dependencies: [],
        instructions: "Fix",
      },
    ],
  };
  assert.deepEqual(
    parseJson(`Here is the plan:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``),
    plan,
  );
  assert.throws(
    () => parseJson(`${JSON.stringify(plan)}\n${JSON.stringify(plan)}`),
    /structured JSON/,
  );
});
test("baseline selection keeps convention tests and added globs", () => {
  const files = [
    { path: "src/author.ts", hash: "a" },
    { path: "sum.test.cjs", hash: "b" },
    { path: "tests/readme.md", hash: "c" },
    { path: "extra/custom.js", hash: "d" },
  ];
  const selected = baselineTestPaths(files, ["extra/*.js"]).map(
    (file) => file.path,
  );
  assert.deepEqual(selected, [
    "sum.test.cjs",
    "tests/readme.md",
    "extra/custom.js",
  ]);
});
test("task graph rejects cycles and runs only after dependencies", async () => {
  assert.throws(
    () =>
      validateGraph([
        { id: "a", dependencies: ["b"] },
        { id: "b", dependencies: ["a"] },
      ]),
    /cycle/i,
  );
  assert.throws(
    () => validateGraph([{ id: "a", dependencies: ["missing"] }]),
    /Unknown/,
  );
  const finished: string[] = [];
  await runGraph(
    [
      { id: "a", dependencies: [] },
      { id: "b", dependencies: ["a"] },
      { id: "c", dependencies: ["a"] },
    ],
    2,
    async (t) => {
      if (t.id !== "a") assert.ok(finished.includes("a"));
      finished.push(t.id);
      return t.id;
    },
  );
  assert.deepEqual(finished.sort(), ["a", "b", "c"]);
});
// This adapter replaces only paid inference. Git, broker writes, commands, artifacts,
// checks, review parsing, and the delivery gate below are real production components.
function adapter(): ModelAdapter {
  return {
    capabilities: () => ({
      streaming: true,
      tools: true,
      images: false,
      structuredOutput: false,
    }),
    estimateUsage: () => ({ inputTokens: 1, outputTokens: 100, cost: 0.01 }),
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      const last = req.messages.at(-1)!;
      if (req.system.includes("ROUTING CONTRACT"))
        yield {
          type: "text",
          delta: JSON.stringify({
            schemaVersion: 1,
            owner: "assistant",
            collaborators: ["dev", "test", "review"],
            workflow: "small",
            outcome: "Correct sum",
            scope: "write",
            risks: [],
            placement: "local",
            clarifications: [],
            artifacts: [],
          }),
        };
      else if (req.system.includes("ASSESSMENT CONTRACT"))
        yield {
          type: "text",
          delta: JSON.stringify({
            verdict: "approved",
            findings: [],
            summary: "Inspected sum and regression assertions.",
          }),
        };
      else if (req.system.includes("You are @dev") && last.role !== "tool")
        yield {
          type: "tool_call",
          call: {
            id: "fix",
            name: "write",
            arguments: {
              path: "sum.cjs",
              content: "module.exports = (a,b) => a+b;\n",
            },
          },
        };
      else
        yield { type: "text", delta: "Completed task; inspect test evidence." };
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
      };
      yield {
        type: "finish",
        reason:
          last.role !== "tool" && req.system.includes("You are @dev")
            ? "tool_calls"
            : "stop",
      };
    },
  };
}
async function fixture(
  checks: { name: string; command: string[] }[] = [
    { name: "regression", command: ["node", "sum.test.cjs"] },
  ],
) {
  const root = await mkdtemp(join(tmpdir(), "tfvn-flow-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@example.test",
  ]);
  await writeFile(join(root, "sum.cjs"), "module.exports = (a,b) => a-b;\n");
  await writeFile(
    join(root, "sum.test.cjs"),
    "const assert=require('node:assert/strict');assert.equal(require('./sum.cjs')(2,3),5);\n",
  );
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  const state = await mkdtemp(join(tmpdir(), "tfvn-state-"));
  const journal = new Journal(join(state, "sessions.sqlite"));
  const session = journal.createSession(root);
  const sandbox: Sandbox = {
    identity: "test-only:host-node24",
    available: async () => true,
    run: (r) =>
      runProcess(r.argv, {
        cwd: r.workspace,
        signal: r.signal,
        onOutput: r.onOutput,
      }),
  };
  const config = loadConfig({
    project: {
      checks,
    },
  });
  const controller = new Controller({
    repository: root,
    stateRoot: state,
    journal,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    config,
    sandbox,
    adapter: () => adapter(),
    grants: ["read", "edit", "execute"],
  });
  return { root, controller, journal, session };
}
test("a full local change delivers isolated branch with real tests and matching review", async () => {
  const { root, controller, journal, session } = await fixture();
  const result = await controller.execute(session.id, "Fix sum");
  assert.equal(result.status, "completed", result.blockers.join("\n"));
  assert.ok(result.branch?.startsWith("tfvn/"));
  assert.equal(result.checks[0]?.status, "passed");
  assert.equal(result.reviews[0]?.identity.candidate, result.revision);
  assert.match(result.reviews[0]?.identity.baseline ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    await readFile(join(root, "sum.cjs"), "utf8"),
    "module.exports = (a,b) => a-b;\n",
  );
  assert.equal(
    await readFile(join(result.workspace!, "sum.cjs"), "utf8"),
    "module.exports = (a,b) => a+b;\n",
  );
  assert.equal(journal.session(session.id).status, "completed");
  journal.close();
});
test("missing execution authority blocks implementation before any product edit", async () => {
  const { root, controller, journal, session } = await fixture();
  controller.options.grants = ["read"];
  const result = await controller.execute(session.id, "Fix sum");
  assert.equal(result.status, "blocked");
  assert.match(result.blockers.join(" "), /permission|authorize/i);
  assert.match(await readFile(join(root, "sum.cjs"), "utf8"), /a-b/);
  journal.close();
});
test("completed resume returns the same deliverable without new inference", async () => {
  const ctx = await fixture();
  const first = await ctx.controller.execute(ctx.session.id, "Fix sum");
  ctx.controller.options.adapter = () => {
    throw new Error("No further inference allowed");
  };
  const resumed = await ctx.controller.execute(ctx.session.id, "", {
    resume: true,
  });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.revision, first.revision);
  assert.equal(resumed.id, first.id);
  ctx.journal.close();
});
test("failed preflight releases the lease for the next request", async () => {
  const ctx = await fixture();
  await ctx.controller.execute(ctx.session.id, "Fix sum");
  ctx.controller.options.config.limits.steps++;
  await assert.rejects(
    ctx.controller.execute(ctx.session.id, "", { resume: true }),
    /Configuration/,
  );
  assert.equal(
    ctx.journal.acquire(`session:${ctx.session.id}`, "test-owner"),
    true,
  );
  ctx.journal.release(`session:${ctx.session.id}`, "test-owner");
  ctx.journal.close();
});
test("interrupted review resumes using its immutable prompt and workspace", async () => {
  const ctx = await fixture();
  const factory = ctx.controller.options.adapter;
  let failed = false;
  ctx.controller.options.adapter = (role) => {
    if (role.id !== "review") return factory(role);
    const real = factory(role);
    return {
      ...real,
      stream: async function* (req: ModelRequest) {
        if (!failed) {
          failed = true;
          throw new Error("Transient review outage");
        }
        yield* real.stream(req);
      },
    };
  };
  const blocked = await ctx.controller.execute(ctx.session.id, "Fix sum");
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.summary, /Transient/);
  const resumed = await ctx.controller.execute(ctx.session.id, "", {
    resume: true,
  });
  assert.equal(resumed.status, "completed", resumed.summary);
  ctx.journal.close();
});
test("steering after assessment reroutes through assistant and invalidates prior evidence", async () => {
  const ctx = await fixture(),
    factory = ctx.controller.options.adapter;
  const messages: string[] = [];
  let routingCalls = 0;
  ctx.controller.options.adapter = (role) => {
    const real = factory(role);
    return {
      ...real,
      stream: async function* (req: ModelRequest): AsyncGenerator<ModelEvent> {
        if (req.system.includes("ROUTING CONTRACT")) {
          routingCalls++;
          if (routingCalls > 1) {
            assert.ok(
              req.messages.some((m) =>
                m.content.includes("Explain the updated sum"),
              ),
            );
            yield {
              type: "text",
              delta: JSON.stringify({
                schemaVersion: 1,
                owner: "assistant",
                collaborators: [],
                workflow: "readonly",
                outcome: "Explain updated code",
                scope: "read",
                risks: [],
                placement: "local",
                clarifications: [],
                artifacts: [],
              }),
            };
            yield {
              type: "usage",
              usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
            };
            yield { type: "finish", reason: "stop" };
            return;
          }
        }
        yield* real.stream(req);
        if (req.system.includes("ASSESSMENT CONTRACT"))
          messages.push("Explain the updated sum");
      },
    };
  };
  try {
    const result = await ctx.controller.execute(ctx.session.id, "Fix sum", {
      steering: () => messages.splice(0),
    });
    assert.equal(result.status, "completed", result.summary);
    assert.equal(routingCalls, 2);
    assert.equal(result.checks.length, 0);
    assert.equal(result.reviews.length, 0);
    const events = ctx.journal.events(ctx.session.id);
    assert.equal(
      events.filter(
        (e) =>
          e.type === "run.completed" &&
          (e.payload as any).status === "completed",
      ).length,
      1,
    );
    assert.ok(events.some((e) => e.type === "evidence.invalidated"));
    const lastRoute = events.filter((e) => e.type === "route").at(-1)!;
    assert.equal((lastRoute.payload as any).owner, "assistant");
  } finally {
    ctx.journal.close();
  }
});
test("feature QA executes frozen independent acceptance tests on the final candidate", async () => {
  const ctx = await fixture(),
    factory = ctx.controller.options.adapter;
  ctx.controller.options.adapter = (role) => {
    const real = factory(role);
    return {
      ...real,
      stream: async function* (req: ModelRequest): AsyncGenerator<ModelEvent> {
        if (req.system.includes("ROUTING CONTRACT"))
          yield {
            type: "text",
            delta: JSON.stringify({
              schemaVersion: 1,
              owner: "assistant",
              collaborators: ["dev", "qa", "review"],
              workflow: "feature",
              outcome: "Correct sum",
              scope: "write",
              risks: [],
              placement: "local",
              clarifications: [],
              artifacts: [],
            }),
          };
        else if (req.system.includes("QA PLAN CONTRACT")) {
          const prefix = /Acceptance directory: ([^\n]+)/.exec(req.system)![1];
          yield {
            type: "text",
            delta: JSON.stringify({
              cases: [
                { id: "QA1", criterion: "AC1", description: "Negative inputs" },
              ],
              files: [
                {
                  path: "acceptance.test.js",
                  content:
                    "const {test}=require('node:test');const assert=require('node:assert/strict');test('negative inputs',()=>{assert.equal(require('../../sum.cjs')(-2,3),1);});",
                },
              ],
              command: ["true", `${prefix}/acceptance.test.js`],
            }),
          };
        } else if (role.id === "planner")
          yield {
            type: "text",
            delta: JSON.stringify({
              criteria: [{ id: "AC1", text: "Correct sum" }],
              tasks: [
                {
                  id: "dev",
                  department: "dev",
                  dependencies: [],
                  instructions: "Fix sum",
                },
              ],
            }),
          };
        else {
          yield* real.stream(req);
          return;
        }
        yield {
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
        };
        yield { type: "finish", reason: "stop" };
      },
    };
  };
  const result = await ctx.controller.execute(
    ctx.session.id,
    "Build correct sum",
  );
  assert.equal(result.status, "completed", result.summary);
  assert.equal(
    result.checks.find((c) => c.name === "independent-qa")?.status,
    "passed",
  );
  ctx.journal.close();
});
test("a check that writes an untracked cache still delivers a clean candidate", async () => {
  const outputs: string[] = [];
  const ctx = await fixture([
    {
      name: "regression",
      command: [
        "node",
        "-e",
        "for (let i=0;i<40;i++) console.log('line-'+i); require('node:fs').writeFileSync('cache-out.txt','x'); require('node:child_process').execFileSync(process.execPath,['sum.test.cjs'],{stdio:'inherit'})",
      ],
    },
  ]);
  ctx.controller.options.onEvent = (event) => {
    if (event.type === "command.output")
      outputs.push((event.payload as { chunk: string }).chunk);
  };
  const result = await ctx.controller.execute(ctx.session.id, "Fix sum");
  assert.equal(result.status, "completed", result.summary);
  assert.equal(result.checks[0]?.status, "passed");
  assert.equal(
    result.checks.find((check) => check.name === "baseline-tests")?.status,
    "passed",
  );
  assert.equal(outputs.length, 2);
  assert.ok(
    outputs.every((chunk) => /line-0/.test(chunk) && /line-39/.test(chunk)),
  );
  const status = execFileSync(
    "git",
    ["-C", result.workspace!, "status", "--porcelain=v1"],
    { encoding: "utf8" },
  );
  assert.equal(status.trim(), "");
  const listed = execFileSync(
    "git",
    ["-C", ctx.root, "worktree", "list", "--porcelain"],
    { encoding: "utf8" },
  );
  assert.equal(listed.includes("check-regression"), false);
  ctx.journal.close();
});
test("a check that rewrites tracked source fails inside the repair loop", async () => {
  const ctx = await fixture([
    {
      name: "regression",
      command: [
        "node",
        "-e",
        "require('node:fs').writeFileSync('sum.cjs','module.exports=(a,b)=>0\\n')",
      ],
    },
  ]);
  const result = await ctx.controller.execute(ctx.session.id, "Fix sum");
  assert.equal(result.status, "blocked");
  assert.match(result.summary, /Repair limit|Check did not pass/);
  assert.match(result.checks[0]?.logTail ?? "", /sum\.cjs/);
  assert.equal(
    await readFile(join(result.workspace!, "sum.cjs"), "utf8"),
    "module.exports = (a,b) => a+b;\n",
  );
  ctx.journal.close();
});
test("editing only the baseline test cannot satisfy delivery", async () => {
  const ctx = await fixture();
  const factory = ctx.controller.options.adapter;
  ctx.controller.options.adapter = (role) => {
    const real = factory(role);
    return {
      ...real,
      stream: async function* (req: ModelRequest): AsyncGenerator<ModelEvent> {
        const last = req.messages.at(-1)!;
        if (req.system.includes("You are @dev") && last.role !== "tool") {
          yield {
            type: "tool_call",
            call: {
              id: "weaken",
              name: "write",
              arguments: {
                path: "sum.test.cjs",
                content:
                  "const assert=require('node:assert/strict');assert.equal(require('./sum.cjs')(2,3),-1);\n",
              },
            },
          };
          yield {
            type: "usage",
            usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
          };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield* real.stream(req);
      },
    };
  };
  const result = await ctx.controller.execute(ctx.session.id, "Fix sum");
  assert.equal(result.status, "blocked");
  assert.match(result.summary, /baseline-tests/);
  assert.equal(
    result.checks.find((check) => check.name === "baseline-tests")?.status,
    "failed",
  );
  ctx.journal.close();
});
test("planner correction accepts one JSON document after two documents", async () => {
  const ctx = await fixture();
  const factory = ctx.controller.options.adapter;
  const plan = {
    criteria: [{ id: "AC1", text: "Correct sum" }],
    tasks: [
      {
        id: "dev",
        department: "dev",
        dependencies: [],
        instructions: "Fix sum",
      },
    ],
  };
  ctx.controller.options.adapter = (role) => {
    const real = factory(role);
    return {
      ...real,
      stream: async function* (req: ModelRequest): AsyncGenerator<ModelEvent> {
        if (req.system.includes("ROUTING CONTRACT")) {
          yield {
            type: "text",
            delta: JSON.stringify({
              schemaVersion: 1,
              owner: "assistant",
              collaborators: ["dev", "qa", "review"],
              workflow: "feature",
              outcome: "Correct sum",
              scope: "write",
              risks: [],
              placement: "local",
              clarifications: [],
              artifacts: [],
            }),
          };
        } else if (req.system.includes("QA PLAN CONTRACT")) {
          yield {
            type: "text",
            delta: JSON.stringify({
              cases: [
                { id: "QA1", criterion: "AC1", description: "Negative inputs" },
              ],
              files: [
                {
                  path: "acceptance.test.js",
                  content:
                    "const {test}=require('node:test');const assert=require('node:assert/strict');test('negative inputs',()=>{assert.equal(require('../../sum.cjs')(-2,3),1);});",
                },
              ],
            }),
          };
        } else if (
          role.id === "planner" &&
          req.system.includes("Previous reply rejected")
        ) {
          yield { type: "text", delta: JSON.stringify(plan) };
        } else if (role.id === "planner") {
          yield {
            type: "text",
            delta: `${JSON.stringify(plan)}\n${JSON.stringify(plan)}`,
          };
        } else {
          yield* real.stream(req);
          return;
        }
        yield {
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
        };
        yield { type: "finish", reason: "stop" };
      },
    };
  };
  const result = await ctx.controller.execute(ctx.session.id, "Fix sum");
  assert.equal(result.status, "completed", result.summary);
  ctx.journal.close();
});
test("two invalid planner replies block the phase", async () => {
  const ctx = await fixture();
  const factory = ctx.controller.options.adapter;
  ctx.controller.options.adapter = (role) => {
    const real = factory(role);
    return {
      ...real,
      stream: async function* (req: ModelRequest): AsyncGenerator<ModelEvent> {
        if (req.system.includes("ROUTING CONTRACT")) {
          yield {
            type: "text",
            delta: JSON.stringify({
              schemaVersion: 1,
              owner: "assistant",
              collaborators: [],
              workflow: "feature",
              outcome: "Correct sum",
              scope: "write",
              risks: [],
              placement: "local",
              clarifications: [],
              artifacts: [],
            }),
          };
        } else if (role.id === "planner") {
          yield { type: "text", delta: "nope" };
        } else {
          yield* real.stream(req);
          return;
        }
        yield {
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
        };
        yield { type: "finish", reason: "stop" };
      },
    };
  };
  const result = await ctx.controller.execute(ctx.session.id, "Fix sum");
  assert.equal(result.status, "blocked");
  assert.match(
    result.summary,
    /Department did not return valid structured JSON \(plan\)/,
  );
  ctx.journal.close();
});
test("acceptance that already passes on the baseline does not count as QA", async () => {
  const ctx = await fixture();
  const factory = ctx.controller.options.adapter;
  ctx.controller.options.adapter = (role) => {
    const real = factory(role);
    return {
      ...real,
      stream: async function* (req: ModelRequest): AsyncGenerator<ModelEvent> {
        if (req.system.includes("ROUTING CONTRACT")) {
          yield {
            type: "text",
            delta: JSON.stringify({
              schemaVersion: 1,
              owner: "assistant",
              collaborators: ["dev", "qa", "review"],
              workflow: "feature",
              outcome: "Correct sum",
              scope: "write",
              risks: [],
              placement: "local",
              clarifications: [],
              artifacts: [],
            }),
          };
        } else if (req.system.includes("QA PLAN CONTRACT")) {
          yield {
            type: "text",
            delta: JSON.stringify({
              cases: [
                { id: "QA1", criterion: "AC1", description: "Current bug" },
              ],
              files: [
                {
                  path: "acceptance.test.js",
                  content:
                    "const {test}=require('node:test');const assert=require('node:assert/strict');test('bug',()=>{assert.equal(require('../../sum.cjs')(2,3),-1);});",
                },
              ],
              command: ["true", "ignored"],
            }),
          };
        } else if (role.id === "planner") {
          yield {
            type: "text",
            delta: JSON.stringify({
              criteria: [{ id: "AC1", text: "Correct sum" }],
              tasks: [
                {
                  id: "dev",
                  department: "dev",
                  dependencies: [],
                  instructions: "Fix sum",
                },
              ],
            }),
          };
        } else {
          yield* real.stream(req);
          return;
        }
        yield {
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
        };
        yield { type: "finish", reason: "stop" };
      },
    };
  };
  const result = await ctx.controller.execute(
    ctx.session.id,
    "Build correct sum",
  );
  assert.equal(result.status, "blocked");
  assert.match(result.summary, /already pass on the baseline/);
  assert.equal(
    result.checks.find((check) => check.name === "independent-qa"),
    undefined,
  );
  ctx.journal.close();
});
test("an integration conflict stays in the repair loop", async () => {
  const ctx = await fixture();
  const factory = ctx.controller.options.adapter;
  ctx.controller.options.adapter = (role) => {
    const real = factory(role);
    return {
      ...real,
      stream: async function* (req: ModelRequest): AsyncGenerator<ModelEvent> {
        if (req.system.includes("ROUTING CONTRACT")) {
          yield {
            type: "text",
            delta: JSON.stringify({
              schemaVersion: 1,
              owner: "assistant",
              collaborators: [],
              workflow: "feature",
              outcome: "Correct sum",
              scope: "write",
              risks: [],
              placement: "local",
              clarifications: [],
              artifacts: [],
            }),
          };
        } else if (req.system.includes("QA PLAN CONTRACT")) {
          yield {
            type: "text",
            delta: JSON.stringify({
              cases: [
                { id: "QA1", criterion: "AC1", description: "Negative inputs" },
              ],
              files: [
                {
                  path: "acceptance.test.js",
                  content:
                    "const {test}=require('node:test');const assert=require('node:assert/strict');test('negative inputs',()=>{assert.equal(require('../../sum.cjs')(-2,3),1);});",
                },
              ],
            }),
          };
        } else if (role.id === "planner") {
          yield {
            type: "text",
            delta: JSON.stringify({
              criteria: [{ id: "AC1", text: "Correct sum" }],
              tasks: [
                {
                  id: "one",
                  department: "dev",
                  dependencies: [],
                  instructions: "Fix sum",
                },
                {
                  id: "two",
                  department: "dev",
                  dependencies: [],
                  instructions: "Fix sum again",
                },
              ],
            }),
          };
        } else if (
          req.system.includes("You are @dev") &&
          req.messages.at(-1)?.role !== "tool"
        ) {
          const again = req.messages.some((message) =>
            message.content.includes("Fix sum again"),
          );
          yield {
            type: "tool_call",
            call: {
              id: again ? "second" : "first",
              name: "write",
              arguments: {
                path: "sum.cjs",
                content: again
                  ? "module.exports = (a,b) => a+b+1;\n"
                  : "module.exports = (a,b) => a+b;\n",
              },
            },
          };
          yield {
            type: "usage",
            usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
          };
          yield { type: "finish", reason: "tool_calls" };
          return;
        } else {
          yield* real.stream(req);
          return;
        }
        yield {
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
        };
        yield { type: "finish", reason: "stop" };
      },
    };
  };
  const result = await ctx.controller.execute(ctx.session.id, "Fix sum");
  const events = ctx.journal.events(ctx.session.id);
  const conflict = events.find((event) => event.type === "repair.required");
  assert.ok(conflict, result.summary);
  assert.equal((conflict?.payload as { round?: number }).round, 0);
  assert.match(JSON.stringify(conflict?.payload), /sum\.cjs/);
  assert.ok(
    events.some(
      (event) =>
        event.type === "handoff" &&
        (event.payload as { department?: string; taskId?: string })
          .department === "dev" &&
        String((event.payload as { taskId?: string }).taskId).startsWith(
          "repair-",
        ),
    ),
  );
  assert.notEqual(result.status, undefined);
  ctx.journal.close();
});
test("a read-only route cannot satisfy a fix when edit and execute are granted", async () => {
  const ctx = await fixture();
  const factory = ctx.controller.options.adapter;
  ctx.controller.options.adapter = (role) => {
    const real = factory(role);
    return {
      ...real,
      stream: async function* (req: ModelRequest): AsyncGenerator<ModelEvent> {
        if (req.system.includes("ROUTING CONTRACT")) {
          yield {
            type: "text",
            delta: JSON.stringify({
              schemaVersion: 1,
              owner: "assistant",
              collaborators: [],
              workflow: "readonly",
              outcome: "Just looking",
              scope: "read",
              risks: [],
              placement: "local",
              clarifications: [],
              artifacts: [],
            }),
          };
        } else if (req.system.includes("Previous reply rejected")) {
          yield {
            type: "text",
            delta: JSON.stringify({
              schemaVersion: 1,
              owner: "assistant",
              collaborators: [],
              workflow: "readonly",
              outcome: "Still looking",
              scope: "read",
              risks: [],
              placement: "local",
              clarifications: [],
              artifacts: [],
            }),
          };
        } else {
          yield* real.stream(req);
          return;
        }
        yield {
          type: "usage",
          usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 },
        };
        yield { type: "finish", reason: "stop" };
      },
    };
  };
  const result = await ctx.controller.execute(ctx.session.id, "Fix sum");
  assert.equal(result.status, "blocked");
  assert.match(result.summary, /read-only/);
  assert.match(await readFile(join(ctx.root, "sum.cjs"), "utf8"), /a-b/);
  ctx.journal.close();
});
