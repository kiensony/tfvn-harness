import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "../packages/core/src/runtime.js";
import { Journal } from "../packages/core/src/journal.js";
import { ArtifactStore } from "../packages/core/src/artifacts.js";
import { PermissionPolicy, ToolBroker } from "../packages/core/src/tools.js";
import { departments } from "../packages/core/src/departments.js";
import {
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "../packages/core/src/model.js";
import { type TaskSpec } from "../packages/core/src/contracts.js";
async function setup(adapter: ModelAdapter) {
  const root = await mkdtemp(join(tmpdir(), "tfvn-runtime-"));
  const journal = new Journal(":memory:"),
    session = journal.createSession(root);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = new ToolBroker(
    root,
    new PermissionPolicy(["read", "edit"]),
    artifacts,
  );
  const runtime = new AgentRuntime({
    journal,
    artifacts,
    broker,
    adapter,
    limits: { task: 50, session: 500, daily: 1000 },
  });
  const task: TaskSpec = {
    schemaVersion: 1,
    id: "task",
    sessionId: session.id,
    department: "dev",
    request: "Create hello.txt",
    dependencies: [],
    snapshot: "snap",
    requirements: "req",
    permissions: ["read", "edit"],
    budget: { dollars: 50, steps: 5, durationMs: 60000, maxOutputTokens: 100 },
    placement: "local",
    generation: 1,
  };
  return { root, journal, session, artifacts, broker, runtime, task };
}
function scripted(responses: ModelEvent[][]): ModelAdapter {
  return {
    capabilities: () => ({
      streaming: true,
      tools: true,
      images: false,
      structuredOutput: false,
    }),
    estimateUsage: () => ({ inputTokens: 10, outputTokens: 20, cost: 1 }),
    async *stream(req: ModelRequest) {
      req.signal.throwIfAborted();
      const events = responses.shift();
      if (!events) throw new Error("Unexpected model call");
      for (const e of events) yield e;
    },
  };
}
const use = {
  type: "usage" as const,
  usage: { inputTokens: 1, outputTokens: 1, cost: 0.01 },
};
test("runtime executes complete tool calls and recovers without repeating completed effects", async () => {
  const adapter = scripted([
    [
      {
        type: "tool_call",
        call: {
          id: "c1",
          name: "write",
          arguments: { path: "hello.txt", content: "hello" },
        },
      },
      use,
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text", delta: "Created hello.txt" },
      use,
      { type: "finish", reason: "stop" },
    ],
  ]);
  const { runtime, task, root, journal } = await setup(adapter);
  const result = await runtime.run(task, departments.dev!);
  assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "hello");
  assert.equal(result.text, "Created hello.txt");
  assert.equal(journal.spending(task.sessionId).settled, 0.02);
  assert.equal(
    (await runtime.run(task, departments.dev!)).text,
    "Created hello.txt",
  );
  journal.close();
});
test("partial responses cannot execute tool effects or claim completion", async () => {
  const adapter = scripted([
    [
      {
        type: "tool_call",
        call: {
          id: "c1",
          name: "write",
          arguments: { path: "hello.txt", content: "hello" },
        },
      },
    ],
  ]);
  const { runtime, task, root, journal } = await setup(adapter);
  await assert.rejects(
    runtime.run(task, departments.dev!),
    /terminal|incomplete/i,
  );
  await assert.rejects(readFile(join(root, "hello.txt")));
  assert.equal(journal.spending(task.sessionId).reserved, 1);
  journal.close();
});
test("step and budget limits stop work without manufacturing approval", async () => {
  const { runtime, task, journal } = await setup(
    scripted([
      [
        { type: "tool_call", call: { id: "c1", name: "files", arguments: {} } },
        use,
        { type: "finish", reason: "tool_calls" },
      ],
    ]),
  );
  task.budget.steps = 1;
  await assert.rejects(runtime.run(task, departments.dev!), /step limit/i);
  journal.close();
  const other = await setup(scripted([]));
  other.task.budget.dollars = 0.5;
  await assert.rejects(
    other.runtime.run(other.task, departments.dev!),
    /Budget/,
  );
  other.journal.close();
});
test("cancellation prevents inference and uncertain tool operations cannot replay", async () => {
  const ctx = await setup(scripted([]));
  await assert.rejects(
    ctx.runtime.run(ctx.task, departments.dev!, {
      signal: AbortSignal.abort(new Error("cancelled")),
    }),
    /cancelled/,
  );
  ctx.journal.close();
});
test("invalid patch is a recoverable tool observation instead of an uncertain write", async () => {
  const a = scripted([
    [
      {
        type: "tool_call",
        call: {
          id: "bad",
          name: "patch",
          arguments: { path: "missing", oldText: "x", newText: "y" },
        },
      },
      use,
      { type: "finish", reason: "tool_calls" },
    ],
    [
      {
        type: "tool_call",
        call: {
          id: "good",
          name: "write",
          arguments: { path: "hello.txt", content: "recovered" },
        },
      },
      use,
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text", delta: "Recovered from missing file" },
      use,
      { type: "finish", reason: "stop" },
    ],
  ]);
  const ctx = await setup(a);
  const result = await ctx.runtime.run(ctx.task, departments.dev!);
  assert.equal(result.text, "Recovered from missing file");
  assert.equal(
    await readFile(join(ctx.root, "hello.txt"), "utf8"),
    "recovered",
  );
  ctx.journal.close();
});

test("a model cannot invoke a tool outside its department tool list", async () => {
  const adapter = scripted([
    [
      {
        type: "tool_call",
        call: {
          id: "w",
          name: "write",
          arguments: { path: "hello.txt", content: "forbidden" },
        },
      },
      use,
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text", delta: "No write permission" },
      use,
      { type: "finish", reason: "stop" },
    ],
  ]);
  const ctx = await setup(adapter);
  await ctx.runtime.run(ctx.task, { ...departments.dev!, tools: ["read"] });
  await assert.rejects(readFile(join(ctx.root, "hello.txt")));
  ctx.journal.close();
});

test("independent read tools execute concurrently", async () => {
  const { z } = await import("zod");
  let active = 0,
    peak = 0;
  const a = scripted([
    [
      { type: "tool_call", call: { id: "r1", name: "lookup", arguments: {} } },
      { type: "tool_call", call: { id: "r2", name: "lookup", arguments: {} } },
      use,
      { type: "finish", reason: "tool_calls" },
    ],
    [
      { type: "text", delta: "Read both" },
      use,
      { type: "finish", reason: "stop" },
    ],
  ]);
  const ctx = await setup(a);
  ctx.broker.extensions.register({
    name: "lookup",
    description: "Read lookup",
    schema: z.object({}),
    capability: "read",
    sideEffect: false,
    location: "broker",
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    execute: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return "read";
    },
  });
  await ctx.runtime.run(ctx.task, { ...departments.dev!, tools: ["lookup"] });
  assert.equal(peak, 2);
  ctx.journal.close();
});
