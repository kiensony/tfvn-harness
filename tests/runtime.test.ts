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
test("token deltas stay out of the journal and the finished text is recorded once", async () => {
  const deltas = Array.from({ length: 2000 }, () => ({
    type: "text" as const,
    delta: "a",
  }));
  const ctx = await setup(
    scripted([[...deltas, use, { type: "finish", reason: "stop" }]]),
  );
  const result = await ctx.runtime.run(ctx.task, departments.dev!);
  assert.equal(result.text, "a".repeat(2000));
  const events = ctx.journal.events(ctx.task.sessionId);
  assert.equal(events.filter((e) => e.type === "model.text").length, 0);
  assert.ok(events.length < 10);
  const done = events.find((e) => e.type === "model.completed");
  assert.equal((done?.payload as { summary?: string }).summary, result.text);
  ctx.journal.close();
});
test("usage reported before a tool-argument failure is settled and the model can continue", async () => {
  let turn = 0;
  const adapter: ModelAdapter = {
    capabilities: () => ({
      streaming: true,
      tools: true,
      images: false,
      structuredOutput: false,
    }),
    estimateUsage: () => ({ inputTokens: 10, outputTokens: 20, cost: 1 }),
    async *stream() {
      turn++;
      if (turn === 1) {
        yield {
          type: "usage",
          usage: { inputTokens: 4, outputTokens: 2, cost: 0.25 },
        };
        const { ProviderError } = await import("../packages/core/src/model.js");
        throw new ProviderError("Invalid tool arguments JSON");
      }
      yield { type: "text", delta: "recovered" };
      yield use;
      yield { type: "finish" as const, reason: "stop" as const };
    },
  };
  const ctx = await setup(adapter);
  const result = await ctx.runtime.run(ctx.task, departments.dev!);
  assert.equal(result.text, "recovered");
  assert.equal(ctx.journal.spending(ctx.task.sessionId).settled, 0.26);
  assert.equal(ctx.journal.spending(ctx.task.sessionId).reserved, 0);
  ctx.journal.close();
});
test("invalid tool JSON becomes an observation and a later call can edit", async () => {
  const ctx = await setup(
    scripted([
      [
        {
          type: "tool_call",
          call: { id: "bad", name: "write", arguments: "{not json" },
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
            arguments: { path: "hello.txt", content: "fixed" },
          },
        },
        use,
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", delta: "fixed the call" },
        use,
        { type: "finish", reason: "stop" },
      ],
    ]),
  );
  const result = await ctx.runtime.run(ctx.task, departments.dev!);
  assert.equal(result.text, "fixed the call");
  assert.equal(await readFile(join(ctx.root, "hello.txt"), "utf8"), "fixed");
  const saved = ctx.journal.checkpoint<{
    messages: { role: string; content: string }[];
  }>(ctx.task.sessionId, "agent:task");
  assert.match(
    saved!.messages.find((m) => m.role === "tool")!.content,
    /Invalid tool arguments JSON/,
  );
  ctx.journal.close();
});
test("duplicate tool call ids are observations and do not write", async () => {
  const ctx = await setup(
    scripted([
      [
        {
          type: "tool_call",
          call: {
            id: "same",
            name: "write",
            arguments: { path: "hello.txt", content: "one" },
          },
        },
        {
          type: "tool_call",
          call: {
            id: "same",
            name: "write",
            arguments: { path: "hello.txt", content: "two" },
          },
        },
        use,
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", delta: "did not write" },
        use,
        { type: "finish", reason: "stop" },
      ],
    ]),
  );
  await ctx.runtime.run(ctx.task, departments.dev!);
  await assert.rejects(readFile(join(ctx.root, "hello.txt")));
  ctx.journal.close();
});
test("read-only tool results are appended in call order", async () => {
  const { z } = await import("zod");
  const ctx = await setup(
    scripted([
      [
        {
          type: "tool_call",
          call: { id: "r1", name: "lookup", arguments: { id: "r1" } },
        },
        {
          type: "tool_call",
          call: { id: "r2", name: "lookup", arguments: { id: "r2" } },
        },
        use,
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", delta: "ordered" },
        use,
        { type: "finish", reason: "stop" },
      ],
    ]),
  );
  ctx.broker.extensions.register({
    name: "lookup",
    description: "Read lookup",
    schema: z.object({ id: z.string() }).strict(),
    capability: "read",
    sideEffect: false,
    location: "broker",
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    execute: async ({ id }) => {
      if (id === "r1") await new Promise((r) => setTimeout(r, 30));
      return id;
    },
  });
  await ctx.runtime.run(ctx.task, { ...departments.dev!, tools: ["lookup"] });
  const saved = ctx.journal.checkpoint<{
    messages: { role: string; callId?: string; content: string }[];
  }>(ctx.task.sessionId, "agent:task");
  const tools = saved!.messages.filter((m) => m.role === "tool");
  assert.deepEqual(
    tools.map((m) => m.callId),
    ["r1", "r2"],
  );
  assert.deepEqual(
    tools.map((m) => m.content),
    ["r1", "r2"],
  );
  ctx.journal.close();
});
test("a context-length error compacts once and the retry is shorter", async () => {
  const sizes: number[] = [];
  const { ProviderError } = await import("../packages/core/src/model.js");
  const adapter: ModelAdapter = {
    capabilities: () => ({
      streaming: true,
      tools: true,
      images: false,
      structuredOutput: false,
    }),
    estimateUsage: () => ({ inputTokens: 10, outputTokens: 20, cost: 1 }),
    async *stream(req: ModelRequest) {
      if (req.system.startsWith("Summarize the earlier")) {
        yield { type: "text", delta: "short summary" };
        yield use;
        yield { type: "finish", reason: "stop" };
        return;
      }
      sizes.push(Buffer.byteLength(JSON.stringify(req.messages)));
      if (sizes.length <= 3) {
        yield {
          type: "tool_call",
          call: { id: `c${sizes.length}`, name: "files", arguments: {} },
        };
        yield use;
        yield { type: "finish", reason: "tool_calls" };
        return;
      }
      if (sizes.length === 4) {
        yield {
          type: "usage",
          usage: { inputTokens: 4, outputTokens: 2, cost: 0.25 },
        };
        throw new ProviderError("maximum context length");
      }
      yield { type: "text", delta: "compacted" };
      yield use;
      yield { type: "finish", reason: "stop" };
    },
  };
  const ctx = await setup(adapter);
  const result = await ctx.runtime.run(ctx.task, departments.dev!);
  assert.equal(result.text, "compacted");
  assert.ok(sizes[4]! < sizes[3]!);
  assert.equal(ctx.journal.spending(ctx.task.sessionId).reserved, 0);
  ctx.journal.close();
});
test("long tool output keeps the head, the tail, and the omitted byte count", async () => {
  const { z } = await import("zod");
  const body = `${"H".repeat(10000)}MIDDLE${"T".repeat(30000)}TAIL_MARKER`;
  const ctx = await setup(
    scripted([
      [
        { type: "tool_call", call: { id: "d", name: "dump", arguments: {} } },
        use,
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text", delta: "saw the tail" },
        use,
        { type: "finish", reason: "stop" },
      ],
    ]),
  );
  ctx.broker.extensions.register({
    name: "dump",
    description: "Dump text",
    schema: z.object({}).strict(),
    capability: "read",
    sideEffect: false,
    location: "broker",
    timeoutMs: 1000,
    maxOutputBytes: 100000,
    execute: async () => body,
  });
  await ctx.runtime.run(ctx.task, { ...departments.dev!, tools: ["dump"] });
  const saved = ctx.journal.checkpoint<{
    messages: { role: string; content: string }[];
  }>(ctx.task.sessionId, "agent:task");
  const observation = saved!.messages.find((m) => m.role === "tool")!.content;
  assert.ok(observation.startsWith("H".repeat(100)));
  assert.ok(observation.endsWith("TAIL_MARKER"));
  assert.match(
    observation,
    /\[\d+ bytes omitted; full artifact [a-f0-9]{64}\]/,
  );
  assert.equal(observation.includes("MIDDLE"), false);
  ctx.journal.close();
});
