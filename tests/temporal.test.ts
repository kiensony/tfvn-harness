import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { Worker, NativeConnection } from "@temporalio/worker";
import { Client, Connection } from "@temporalio/client";
import { PostgresCloudStore } from "../packages/cloud/src/store.js";
import { PostgresAdmission } from "../packages/cloud/src/admission.js";
import { createActivities } from "../packages/cloud/src/activities.js";
import { TemporalDispatcher } from "../packages/cloud/src/temporal.js";
import { CloudApi } from "../packages/cloud/src/api.js";
import { ArtifactStore } from "../packages/core/src/artifacts.js";
import { DockerSandbox } from "../packages/core/src/sandbox.js";

test(
  "Temporal and PostgreSQL execute a real activity and persist an unavailable-model block",
  {
    skip: !process.env.TEMPORAL_TEST_ADDRESS || !process.env.TEST_DATABASE_URL,
  },
  async () => {
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      schema = "tfvn_temporal_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const root = await mkdtemp(join(tmpdir(), "tfvn-temporal-"));
    const prior = process.env.TFVN_CONFIG;
    const config = join(root, "trusted.yaml");
    await writeFile(
      config,
      "providers:\n  qwen:\n    baseUrl: https://dashscope-intl.aliyuncs.com/compatible-mode/v1\n    apiKeyEnv: TFVN_TEST_UNSET_CREDENTIAL\n",
    );
    process.env.TFVN_CONFIG = config;
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_TEST_ADDRESS,
    });
    const native = await NativeConnection.connect({
      address: process.env.TEMPORAL_TEST_ADDRESS,
    });
    let worker: Worker | undefined, runPromise: Promise<void> | undefined;
    try {
      const store = new PostgresCloudStore(pool);
      await store.migrate();
      await PostgresAdmission.migrate(pool);
      const queue = "tfvn-test-" + randomUUID();
      const activities = createActivities(
        store,
        root,
        new ArtifactStore(join(root, "artifacts")),
        new DockerSandbox(),
      );
      let activityCalls = 0;
      worker = await Worker.create({
        connection: native,
        taskQueue: queue,
        workflowsPath: fileURLToPath(
          new URL("../packages/cloud/src/workflows.ts", import.meta.url),
        ),
        activities: {
          executeRun: async (id: string) =>
            ++activityCalls === 1 ? false : activities.executeRun(id),
        },
        maxConcurrentActivityTaskExecutions: 1,
      });
      runPromise = worker.run();
      const client = new Client({ connection }),
        api = new CloudApi(store, new TemporalDispatcher(client, queue));
      const record = await api.submit(
        { id: "tester", capabilities: ["read", "upload"] },
        "submission",
        {
          schemaVersion: 1,
          request: "Explain this repository",
          repositoryKey: "fixture",
          mode: "read",
          snapshot: { schemaVersion: 1, base: "a".repeat(40), files: [] },
        },
      );
      await api.steer(
        { id: "tester", capabilities: ["read"] },
        record.id,
        "Explain the module boundaries",
      );
      await client.workflow.getHandle(`tfvn-${record.id}`).result();
      const finished = await store.internalGet(record.id);
      assert.equal(finished?.status, "blocked");
      assert.match(finished!.result!.summary, /TFVN_TEST_UNSET_CREDENTIAL/);
      assert.equal(finished!.generation, 1);
      assert.equal(activityCalls, 2);
      assert.ok(
        (await store.events("tester", record.id, 0)).some(
          (e) => e.type === "evidence.invalidated",
        ),
      );
    } finally {
      if (worker) worker.shutdown();
      await runPromise;
      await native.close();
      await connection.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      if (prior === undefined) delete process.env.TFVN_CONFIG;
      else process.env.TFVN_CONFIG = prior;
    }
  },
);
