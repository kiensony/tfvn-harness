import { Pool } from "pg";
import { Worker, NativeConnection } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { PostgresAdmission } from "./admission.js";
import { PostgresCloudStore } from "./store.js";
import { createActivities } from "./activities.js";
import { artifactStore } from "./storage.js";
import { KubernetesSandbox } from "./kubernetes.js";
import { DockerSandbox } from "../../core/src/sandbox.js";
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const root = process.env.TFVN_WORKER_ROOT ?? "/state/runs",
    image = process.env.TFVN_SANDBOX_IMAGE ?? "tfvn-sandbox:dev";
  const sandbox =
    process.env.TFVN_SANDBOX_BACKEND === "kubernetes"
      ? new KubernetesSandbox({
          root,
          image,
          namespace: process.env.TFVN_NAMESPACE ?? "tfvn",
          volume: process.env.TFVN_WORKSPACE_VOLUME ?? "tfvn-workspaces",
        })
      : new DockerSandbox(image);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const store = new PostgresCloudStore(pool);
  await store.migrate();
  await PostgresAdmission.migrate(pool);
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
    ...(process.env.TEMPORAL_API_KEY
      ? { tls: true, apiKey: process.env.TEMPORAL_API_KEY }
      : {}),
  });
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: "tfvn-runs",
    workflowsPath: fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts") ? "./workflows.ts" : "./workflows.js",
        import.meta.url,
      ),
    ),
    activities: createActivities(
      store,
      root,
      artifactStore(process.env.TFVN_ARTIFACT_DIR ?? "/state/artifacts"),
      sandbox,
    ),
    maxConcurrentActivityTaskExecutions: 32,
  });
  try {
    await worker.run();
  } finally {
    await connection.close();
    await pool.end();
  }
}
main().catch((e) => {
  process.stderr.write(`Worker startup failed: ${e.message}\n`);
  process.exitCode = 1;
});
