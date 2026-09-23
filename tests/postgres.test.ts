import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresCloudStore } from "../packages/cloud/src/store.js";
import { PostgresAdmission } from "../packages/cloud/src/admission.js";

test(
  "PostgreSQL preserves generation fencing and budgets across worker instances",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = "tfvn_test_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      const store = new PostgresCloudStore(pool);
      await store.migrate();
      await PostgresAdmission.migrate(pool);
      const submission = {
        schemaVersion: 1 as const,
        request: "test",
        repositoryKey: "repo",
        mode: "write" as const,
        snapshot: {
          schemaVersion: 1 as const,
          base: "a".repeat(40),
          files: [],
        },
      };
      const run = await store.create("user", "key", "hash", submission);
      assert.equal(
        (await store.create("user", "key", "hash", submission)).id,
        run.id,
      );
      await assert.rejects(
        store.create("user", "key", "other", submission),
        /Idempotency/,
      );
      const now = Date.now(),
        lease = await store.claim(run.id, now, 60000);
      assert.equal(lease?.generation, 1);
      const steering = await store.append(run.id, "steering", {
        text: "Change requirement",
      });
      assert.ok(steering);
      assert.equal(
        await store.finish(run.id, 1, { status: "completed" } as any, now),
        false,
      );
      const limits = {
        run: 1,
        daily: 2,
        requestsPerMinute: 60,
        tokensPerMinute: 10000,
      };
      const ledger = new PostgresAdmission(pool, run.id, 1, limits);
      await ledger.reserve(
        randomUUID(),
        { inputTokens: 10, outputTokens: 10, cost: 0.6 },
        "qwen",
      );
      await assert.rejects(
        new PostgresAdmission(pool, run.id, 1, limits).reserve(
          randomUUID(),
          { inputTokens: 10, outputTokens: 10, cost: 0.6 },
          "qwen",
        ),
        /budget/,
      );
      await store.cancel("user", run.id);
      assert.equal(
        await store.append(run.id, "steering", { text: "late" }),
        undefined,
      );
      assert.equal(
        await store.finish(
          run.id,
          1,
          { status: "completed" } as any,
          Date.now(),
        ),
        false,
      );
      await assert.rejects(
        ledger.reserve(
          randomUUID(),
          { inputTokens: 1, outputTokens: 1, cost: 0.1 },
          "qwen",
        ),
        /stale/,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
test(
  "durable admission shares 32 slots fairly across owners and repositories",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = "tfvn_capacity_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      const store = new PostgresCloudStore(pool);
      await store.migrate();
      const runs = [];
      for (const owner of ["first", "second"])
        for (let i = 0; i < 40; i++) {
          runs.push(
            await store.create(owner, String(i), `${owner}-${i}`, {
              schemaVersion: 1,
              request: "test",
              repositoryKey: `repo-${i % 10}`,
              mode: i < 30 ? "write" : "read",
              snapshot: { schemaVersion: 1, base: "a".repeat(40), files: [] },
            }),
          );
        }
      const active = new Map();
      const now = Date.now();
      for (let round = 0; round < 4; round++) {
        const claims = await Promise.all(
          runs.map((r) => store.claim(r.id, now, 60000)),
        );
        for (const r of claims) if (r) active.set(r.id, r);
      }
      assert.equal(active.size, 32);
      const values = [...active.values()];
      assert.equal(
        values.filter((r) => r.submission.mode === "write").length,
        24,
      );
      for (const owner of ["first", "second"]) {
        assert.equal(values.filter((r) => r.owner === owner).length, 16);
        for (let i = 0; i < 10; i++)
          assert.ok(
            values.filter(
              (r) =>
                r.owner === owner &&
                r.submission.repositoryKey === `repo-${i}` &&
                r.submission.mode === "write",
            ).length <= 4,
          );
      }
      const cancelled = values[0];
      await store.cancel(cancelled.owner, cancelled.id);
      assert.equal(
        await store.finish(
          cancelled.id,
          cancelled.generation,
          { status: "completed" } as any,
          now,
        ),
        false,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
