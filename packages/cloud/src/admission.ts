import { randomUUID } from "node:crypto";
import { type Pool } from "pg";
import {
  type ModelAdapter,
  type ModelRequest,
  type ModelEvent,
} from "../../core/src/model.js";
import { type Usage } from "../../core/src/contracts.js";
export interface AdmissionLedger {
  reserve(id: string, estimate: Usage, provider: string): Promise<void>;
  settle(id: string, usage: Usage): Promise<void>;
}
export class AdmittedAdapter implements ModelAdapter {
  constructor(
    readonly adapter: ModelAdapter,
    readonly ledger: AdmissionLedger,
  ) {}
  capabilities() {
    return this.adapter.capabilities();
  }
  estimateUsage(request: ModelRequest) {
    return this.adapter.estimateUsage(request);
  }
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const id = randomUUID();
    await this.ledger.reserve(
      id,
      this.estimateUsage(request),
      request.model.provider,
    );
    for await (const event of this.adapter.stream(request)) {
      if (event.type === "usage") await this.ledger.settle(id, event.usage);
      yield event;
    }
  }
}
export class PostgresAdmission implements AdmissionLedger {
  constructor(
    readonly pool: Pool,
    readonly runId: string,
    readonly generation: number,
    readonly limits: {
      run: number;
      daily: number;
      requestsPerMinute: number;
      tokensPerMinute: number;
    },
  ) {}
  static async migrate(pool: Pool) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS tfvn_inference(id UUID PRIMARY KEY,run_id UUID NOT NULL REFERENCES tfvn_runs(id),provider TEXT NOT NULL,reserved NUMERIC NOT NULL,actual NUMERIC,tokens BIGINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS tfvn_inference_time ON tfvn_inference(created_at);`,
    );
  }
  async reserve(id: string, estimate: Usage, provider: string) {
    if (!Number.isFinite(estimate.cost) || estimate.cost < 0)
      throw new Error("Invalid inference estimate");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(746387)");
      const run = (
        await c.query(
          "SELECT generation,lease_until,status FROM tfvn_runs WHERE id=$1",
          [this.runId],
        )
      ).rows[0];
      if (
        !run ||
        run.generation !== this.generation ||
        run.status !== "running" ||
        Number(run.lease_until) < Date.now()
      )
        throw new Error("Inference admission rejected for stale worker");
      const spend = (
        await c.query(
          "SELECT COALESCE(SUM(COALESCE(actual,reserved)) FILTER (WHERE run_id=$1),0) AS run,COALESCE(SUM(COALESCE(actual,reserved)) FILTER (WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS daily FROM tfvn_inference",
          [this.runId],
        )
      ).rows[0];
      if (
        Number(spend.run) + estimate.cost > this.limits.run ||
        Number(spend.daily) + estimate.cost > this.limits.daily
      )
        throw new Error(
          "Cloud budget exhausted; reservations persist across retries",
        );
      const rate = (
        await c.query(
          "SELECT COUNT(*) AS requests,COALESCE(SUM(tokens),0) AS tokens FROM tfvn_inference WHERE provider=$1 AND created_at>now()-interval '1 minute'",
          [provider],
        )
      ).rows[0];
      const tokens = estimate.inputTokens + estimate.outputTokens;
      if (
        Number(rate.requests) >= this.limits.requestsPerMinute ||
        Number(rate.tokens) + tokens > this.limits.tokensPerMinute
      )
        throw new Error(
          "Provider admission quota exhausted; retry after the rate window",
        );
      await c.query(
        "INSERT INTO tfvn_inference(id,run_id,provider,reserved,tokens) VALUES($1,$2,$3,$4,$5)",
        [id, this.runId, provider, estimate.cost, tokens],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async settle(id: string, usage: Usage) {
    if (!Number.isFinite(usage.cost) || usage.cost < 0)
      throw new Error("Invalid provider cost");
    await this.pool.query(
      "UPDATE tfvn_inference SET actual=$2 WHERE id=$1 AND run_id=$3",
      [id, usage.cost, this.runId],
    );
  }
}
