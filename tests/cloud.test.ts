import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryCloudStore } from "../packages/cloud/src/store.js";
import { CloudApi } from "../packages/cloud/src/api.js";
import { FairScheduler } from "../packages/cloud/src/scheduler.js";
import { digest } from "../packages/core/src/artifacts.js";
import { validateSnapshot } from "../packages/cloud/src/snapshot.js";
const snapshot = {
  schemaVersion: 1 as const,
  base: "a".repeat(40),
  files: [
    {
      path: "index.ts",
      content: Buffer.from("hello").toString("base64"),
      sha256: digest("hello"),
      mode: "100644" as const,
    },
  ],
};
const submission = {
  schemaVersion: 1,
  request: "Fix sum",
  repositoryKey: "repo-one",
  mode: "write",
  snapshot,
};
const actor = {
  id: "user",
  capabilities: ["read", "edit", "execute", "upload"] as const,
};
test("cloud submission is idempotent and mismatched reuse cannot mutate a run", async () => {
  const store = new MemoryCloudStore();
  const api = new CloudApi(store, {
    start: async () => {},
    cancel: async () => {},
  });
  const a = await api.submit(actor, "key", submission),
    b = await api.submit(actor, "key", submission);
  assert.equal(a.id, b.id);
  await assert.rejects(
    api.submit(actor, "key", { ...submission, request: "other" }),
    /idempotency/i,
  );
  await assert.rejects(
    api.get({ id: "other", capabilities: [] }, a.id),
    /not found/i,
  );
});
test("late generations cannot finalize after lease loss or cancellation", async () => {
  const store = new MemoryCloudStore();
  const run = await store.create("user", "key", "digest", submission as any);
  const first = await store.claim(run.id, 0, 10);
  assert.ok(first);
  const replacement = await store.claim(run.id, 11, 10);
  assert.equal(replacement?.generation, 2);
  assert.equal(
    await store.finish(
      run.id,
      first!.generation,
      { status: "completed" } as any,
      12,
    ),
    false,
  );
  await store.cancel("user", run.id);
  assert.equal(
    await store.finish(
      run.id,
      replacement!.generation,
      { status: "completed" } as any,
      12,
    ),
    false,
  );
  assert.equal((await store.get("user", run.id))?.status, "cancelled");
});
test("events reconnect by sequence without duplication", async () => {
  const store = new MemoryCloudStore();
  const r = await store.create("user", "key", "digest", submission as any);
  await store.append(r.id, "progress", { n: 1 });
  await store.append(r.id, "progress", { n: 2 });
  assert.deepEqual(
    (await store.events("user", r.id, 1)).map((e) => e.sequence),
    [2],
  );
});
test("finalization cannot drop unprocessed steering, and completed runs reject late messages", async () => {
  const store = new MemoryCloudStore();
  const r = await store.create("user", "steer", "digest", submission as any);
  await store.claim(r.id, 0, 100);
  const message = await store.append(r.id, "steering", {
    text: "Change the requirement",
  });
  assert.equal(
    await store.finish(r.id, 1, { status: "completed" } as any, 1),
    false,
  );
  assert.equal(
    await store.finish(
      r.id,
      1,
      { status: "completed" } as any,
      1,
      message!.sequence,
    ),
    true,
  );
  assert.equal(
    await store.append(r.id, "steering", { text: "too late" }),
    undefined,
  );
});
test("portable snapshots reject traversal, symlinks, secrets and content tampering", () => {
  assert.doesNotThrow(() => validateSnapshot(snapshot));
  for (const path of ["../outside", ".git/config", ".env", "/absolute"])
    assert.throws(
      () =>
        validateSnapshot({
          ...snapshot,
          files: [{ ...snapshot.files[0], path }],
        }),
      /path|secret|protected/i,
    );
  assert.throws(
    () =>
      validateSnapshot({
        ...snapshot,
        files: [{ ...snapshot.files[0], sha256: "b".repeat(64) }],
      }),
    /integrity/i,
  );
});
test("32-slot scheduler reserves assessment capacity and enforces repository limits with fairness", () => {
  const scheduler = new FairScheduler();
  for (let user = 0; user < 2; user++)
    for (let i = 0; i < 60; i++)
      scheduler.enqueue({
        id: `${user}-${i}`,
        owner: `user-${user}`,
        repository: `repo-${i % 10}`,
        kind: i < 40 ? "implementation" : "assessment",
      });
  const first = scheduler.admit();
  assert.equal(first.length, 32);
  assert.equal(first.filter((t) => t.kind === "implementation").length, 24);
  assert.equal(new Set(first.map((t) => t.repository)).size, 10);
  assert.equal(new Set(first.map((t) => t.owner)).size, 2);
  for (const repo of new Set(first.map((t) => t.repository)))
    assert.ok(
      first.filter((t) => t.repository === repo && t.kind === "implementation")
        .length <= 4,
    );
  assert.equal(scheduler.admit().length, 0);
  for (const t of first) scheduler.release(t.id);
  assert.equal(scheduler.admit().length, 32);
});

test("inference reservations are shared across worker attempts, including interrupted streams", async () => {
  const { AdmittedAdapter } =
    await import("../packages/cloud/src/admission.js");
  let reserved = 0,
    spent = 0;
  const ledger = {
    reserve: async (_id: string, estimate: any) => {
      if (reserved + spent + estimate.cost > 1) throw new Error("budget");
      reserved += estimate.cost;
    },
    settle: async (_id: string, usage: any) => {
      reserved -= 0.6;
      spent += usage.cost;
    },
  };
  const adapter = {
    capabilities: () => ({
      streaming: true,
      tools: false,
      images: false,
      structuredOutput: false,
    }),
    estimateUsage: () => ({ inputTokens: 1, outputTokens: 1, cost: 0.6 }),
    async *stream() {
      throw new Error("transport interruption");
    },
  };
  const request: any = { model: { provider: "qwen" } };
  async function consume(a: any) {
    for await (const event of a.stream(request)) void event;
  }
  await assert.rejects(
    consume(new AdmittedAdapter(adapter, ledger)),
    /interruption/,
  );
  await assert.rejects(consume(new AdmittedAdapter(adapter, ledger)), /budget/);
  assert.equal(reserved, 0.6);
});

test("HTTP API rejects anonymous requests and cross-owner artifact access", async () => {
  const { cloudServer } = await import("../packages/cloud/src/api.js");
  const store = new MemoryCloudStore();
  const api = new CloudApi(store, {
    start: async () => {},
    cancel: async () => {},
  });
  const server = cloudServer(
    api,
    new Map<string, import("../packages/cloud/src/contracts.js").Principal>([
      ["token-one", actor],
      ["token-two", { id: "other", capabilities: ["read", "upload"] }],
    ]),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base + "/v1/runs")).status, 401);
    const response = await fetch(base + "/v1/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer token-one",
        "content-type": "application/json",
        "idempotency-key": "http-key",
      },
      body: JSON.stringify(submission),
    });
    assert.equal(response.status, 202);
    const run = (await response.json()) as any;
    assert.equal(
      (
        await fetch(base + `/v1/runs/${run.id}`, {
          headers: { authorization: "Bearer token-two" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(base + `/v1/runs/${run.id}/events?after=-1`, {
          headers: { authorization: "Bearer token-one" },
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
