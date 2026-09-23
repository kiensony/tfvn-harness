import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  type CloudRun,
  type CloudStore,
  type Submission,
} from "./contracts.js";
import {
  type SessionEvent,
  type TaskResult,
  type Approval,
} from "../../core/src/contracts.js";
import { digest } from "../../core/src/artifacts.js";
import { chooseAdmissions } from "./scheduler.js";
const copy = <T>(value: T): T => structuredClone(value);
export class MemoryCloudStore implements CloudStore {
  private runs = new Map<string, CloudRun>();
  private log = new Map<string, SessionEvent[]>();
  private approvals = new Map<string, Approval>();
  async create(
    owner: string,
    key: string,
    hash: string,
    submission: Submission,
  ) {
    const old = [...this.runs.values()].find(
      (r) => r.owner === owner && r.key === key,
    );
    if (old) {
      if (old.digest !== hash) throw new Error("Idempotency key conflict");
      return copy(old);
    }
    const run: CloudRun = {
      id: randomUUID(),
      owner,
      key,
      digest: hash,
      submission,
      status: "queued",
      generation: 0,
      leaseUntil: 0,
      createdAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    return copy(run);
  }
  async get(owner: string, id: string) {
    const r = this.runs.get(id);
    return r?.owner === owner ? copy(r) : undefined;
  }
  async internalGet(id: string) {
    const r = this.runs.get(id);
    return r ? copy(r) : undefined;
  }
  async append(
    id: string,
    type: string,
    payload: unknown,
    generation?: number,
  ) {
    const run = this.runs.get(id);
    if (
      !run ||
      (type === "steering" && !["queued", "running"].includes(run.status)) ||
      (generation !== undefined &&
        (run.generation !== generation || run.status !== "running"))
    )
      return undefined;
    const list = this.log.get(id) ?? [];
    const event: SessionEvent = {
      schemaVersion: 1,
      sessionId: id,
      sequence: list.length + 1,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    list.push(event);
    this.log.set(id, list);
    return copy(event);
  }
  async events(owner: string, id: string, after: number) {
    if (!(await this.get(owner, id))) throw new Error("Run not found");
    return copy((this.log.get(id) ?? []).filter((e) => e.sequence > after));
  }
  async claim(id: string, now: number, ttl: number) {
    const run = this.runs.get(id);
    if (
      !run ||
      !["queued", "running"].includes(run.status) ||
      (run.status === "running" && run.leaseUntil > now)
    )
      return undefined;
    if (!chooseAdmissions([...this.runs.values()], now).has(id))
      return undefined;
    run.status = "running";
    run.generation++;
    run.leaseUntil = now + ttl;
    return copy(run);
  }
  async heartbeat(id: string, generation: number, now: number, ttl: number) {
    const r = this.runs.get(id);
    if (
      !r ||
      r.generation !== generation ||
      r.status !== "running" ||
      r.leaseUntil < now
    )
      return false;
    r.leaseUntil = now + ttl;
    return true;
  }
  async finish(
    id: string,
    generation: number,
    result: TaskResult,
    now: number,
    steeringSequence = 0,
  ) {
    const r = this.runs.get(id);
    if (
      !r ||
      r.generation !== generation ||
      r.status !== "running" ||
      r.leaseUntil < now ||
      (this.log.get(id) ?? []).some(
        (e) => e.type === "steering" && e.sequence > steeringSequence,
      )
    )
      return false;
    r.result = copy(result);
    r.status =
      result.status === "completed"
        ? "completed"
        : result.status === "cancelled"
          ? "cancelled"
          : "blocked";
    r.leaseUntil = 0;
    return true;
  }
  async cancel(owner: string, id: string) {
    const r = this.runs.get(id);
    if (!r || r.owner !== owner) throw new Error("Run not found");
    if (["completed", "blocked", "failed", "cancelled"].includes(r.status))
      return;
    r.status = "cancelled";
    r.generation++;
    r.leaseUntil = 0;
  }
  async approve(owner: string, key: string, approval: Approval) {
    const k = owner + ":" + key,
      old = this.approvals.get(k);
    if (old) {
      if (
        old.actionDigest !== approval.actionDigest ||
        old.scope !== approval.scope
      )
        throw new Error("Approval idempotency conflict");
      return old;
    }
    this.approvals.set(k, approval);
    return approval;
  }
}
export class PostgresCloudStore implements CloudStore {
  constructor(readonly pool: Pool) {}
  async migrate() {
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS tfvn_runs(id UUID PRIMARY KEY,owner TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,submission JSONB NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,lease_until BIGINT NOT NULL DEFAULT 0,result JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(owner,key));
    CREATE TABLE IF NOT EXISTS tfvn_events(run_id UUID NOT NULL REFERENCES tfvn_runs(id),sequence BIGINT NOT NULL,event JSONB NOT NULL,PRIMARY KEY(run_id,sequence));
    CREATE TABLE IF NOT EXISTS tfvn_approvals(owner TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,approval JSONB NOT NULL,PRIMARY KEY(owner,key));
    CREATE INDEX IF NOT EXISTS tfvn_runs_active ON tfvn_runs(status,lease_until);`);
  }
  private decode(r: any): CloudRun {
    return {
      id: r.id,
      owner: r.owner,
      key: r.key,
      digest: r.digest,
      submission: r.submission,
      status: r.status,
      generation: r.generation,
      leaseUntil: Number(r.lease_until),
      result: r.result ?? undefined,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async create(
    owner: string,
    key: string,
    hash: string,
    submission: Submission,
  ) {
    await this.pool.query(
      "INSERT INTO tfvn_runs(id,owner,key,digest,submission,status) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner,key) DO NOTHING",
      [randomUUID(), owner, key, hash, submission, "queued"],
    );
    const r = (
      await this.pool.query(
        "SELECT * FROM tfvn_runs WHERE owner=$1 AND key=$2",
        [owner, key],
      )
    ).rows[0];
    if (r.digest !== hash) throw new Error("Idempotency key conflict");
    return this.decode(r);
  }
  async get(owner: string, id: string) {
    const r = (
      await this.pool.query(
        "SELECT * FROM tfvn_runs WHERE owner=$1 AND id=$2",
        [owner, id],
      )
    ).rows[0];
    return r ? this.decode(r) : undefined;
  }
  async internalGet(id: string) {
    const r = (
      await this.pool.query("SELECT * FROM tfvn_runs WHERE id=$1", [id])
    ).rows[0];
    return r ? this.decode(r) : undefined;
  }
  async append(
    id: string,
    type: string,
    payload: unknown,
    generation?: number,
  ) {
    return this.tx(async (c) => {
      const run = (
        await c.query(
          "SELECT generation,status FROM tfvn_runs WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (
        !run ||
        (type === "steering" && !["queued", "running"].includes(run.status)) ||
        (generation !== undefined &&
          (run.generation !== generation || run.status !== "running"))
      )
        return undefined;
      const seq = Number(
        (
          await c.query(
            "SELECT COALESCE(MAX(sequence),0)+1 AS seq FROM tfvn_events WHERE run_id=$1",
            [id],
          )
        ).rows[0].seq,
      );
      const event: SessionEvent = {
        schemaVersion: 1,
        sessionId: id,
        sequence: seq,
        type,
        timestamp: new Date().toISOString(),
        payload,
      };
      await c.query("INSERT INTO tfvn_events VALUES($1,$2,$3)", [
        id,
        seq,
        event,
      ]);
      return event;
    });
  }
  async events(owner: string, id: string, after: number) {
    if (!(await this.get(owner, id))) throw new Error("Run not found");
    return (
      await this.pool.query(
        "SELECT event FROM tfvn_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 1000",
        [id, after],
      )
    ).rows.map((r) => r.event as SessionEvent);
  }
  async claim(id: string, now: number, ttl: number) {
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(746386)");
      const r = (
        await c.query("SELECT * FROM tfvn_runs WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (
        !r ||
        !["queued", "running"].includes(r.status) ||
        (r.status === "running" && Number(r.lease_until) > now)
      )
        return undefined;
      const pending = (
        await c.query(
          "SELECT id,owner,status,lease_until,created_at,submission->>'mode' AS mode,submission->>'repositoryKey' AS repository FROM tfvn_runs WHERE status IN ('queued','running')",
        )
      ).rows.map((row) => ({
        id: row.id,
        owner: row.owner,
        status: row.status,
        leaseUntil: Number(row.lease_until),
        createdAt: new Date(row.created_at).toISOString(),
        submission: { mode: row.mode, repositoryKey: row.repository },
      }));
      if (!chooseAdmissions(pending, now).has(id)) return undefined;
      const updated = (
        await c.query(
          "UPDATE tfvn_runs SET generation=generation+1,status='running',lease_until=$2 WHERE id=$1 RETURNING *",
          [id, now + ttl],
        )
      ).rows[0];
      return this.decode(updated);
    });
  }
  async heartbeat(id: string, generation: number, now: number, ttl: number) {
    return (
      (
        await this.pool.query(
          "UPDATE tfvn_runs SET lease_until=$4 WHERE id=$1 AND generation=$2 AND lease_until>=$3 AND status='running'",
          [id, generation, now, now + ttl],
        )
      ).rowCount === 1
    );
  }
  async finish(
    id: string,
    generation: number,
    result: TaskResult,
    now: number,
    steeringSequence = 0,
  ) {
    const status =
      result.status === "completed"
        ? "completed"
        : result.status === "cancelled"
          ? "cancelled"
          : "blocked";
    return this.tx(async (c) => {
      await c.query("SELECT id FROM tfvn_runs WHERE id=$1 FOR UPDATE", [id]);
      return (
        (
          await c.query(
            "UPDATE tfvn_runs SET status=$5,result=$4,lease_until=0 WHERE id=$1 AND generation=$2 AND lease_until>=$3 AND status='running' AND NOT EXISTS (SELECT 1 FROM tfvn_events WHERE run_id=$1 AND sequence>$6 AND event->>'type'='steering')",
            [id, generation, now, result, status, steeringSequence],
          )
        ).rowCount === 1
      );
    });
  }
  async cancel(owner: string, id: string) {
    if (!(await this.get(owner, id))) throw new Error("Run not found");
    await this.pool.query(
      "UPDATE tfvn_runs SET status='cancelled',generation=generation+1,lease_until=0 WHERE owner=$1 AND id=$2 AND status IN ('running','queued')",
      [owner, id],
    );
  }
  async approve(owner: string, key: string, approval: Approval) {
    const hash = digest({
      scope: approval.scope,
      actionDigest: approval.actionDigest,
    });
    await this.pool.query(
      "INSERT INTO tfvn_approvals VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [owner, key, hash, approval],
    );
    const r = (
      await this.pool.query(
        "SELECT * FROM tfvn_approvals WHERE owner=$1 AND key=$2",
        [owner, key],
      )
    ).rows[0];
    if (r.digest !== hash) throw new Error("Approval idempotency conflict");
    return r.approval as Approval;
  }
}
