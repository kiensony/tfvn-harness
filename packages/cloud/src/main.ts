import { Pool } from "pg";
import { Client } from "@temporalio/client";
import { CloudApi, cloudServer } from "./api.js";
import { PostgresCloudStore } from "./store.js";
import { TemporalDispatcher, temporalConnection } from "./temporal.js";
import { artifactStore } from "./storage.js";
import { z } from "zod";
import { capabilitySchema } from "../../core/src/contracts.js";
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const principals = z
    .array(
      z
        .object({
          token: z.string().min(32),
          id: z.string().min(1),
          capabilities: z.array(capabilitySchema),
        })
        .strict(),
    )
    .min(1)
    .parse(JSON.parse(process.env.TFVN_TOKENS ?? "[]"));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const store = new PostgresCloudStore(pool);
  await store.migrate();
  const connection = await temporalConnection();
  const dispatcher = new TemporalDispatcher(
    new Client({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    }),
  );
  const server = cloudServer(
    new CloudApi(store, dispatcher),
    new Map(
      principals.map((p) => [
        p.token,
        { id: p.id, capabilities: p.capabilities },
      ]),
    ),
    artifactStore(process.env.TFVN_ARTIFACT_DIR ?? "/state/artifacts"),
  );
  server.listen(
    Number(process.env.PORT ?? 8787),
    process.env.HOST ?? "127.0.0.1",
    () => process.stderr.write("TFVN cloud API listening\n"),
  );
  const stop = () => {
    server.close(() => {
      void pool.end();
      void connection.close();
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
main().catch((e) => {
  process.stderr.write(`Cloud startup failed: ${e.message}\n`);
  process.exitCode = 1;
});
