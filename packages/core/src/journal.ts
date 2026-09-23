import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Session,
  type SessionEvent,
  type TaskStatus,
} from "./contracts.js";
export class Journal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,repository TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(session_id TEXT NOT NULL REFERENCES sessions(id),seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS checkpoints(session_id TEXT NOT NULL REFERENCES sessions(id),task_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(session_id,task_id));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,task_id TEXT NOT NULL,amount REAL NOT NULL,actual REAL,state TEXT NOT NULL,day TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks(key TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  createSession(repository: string, id: string = randomUUID()): Session {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
      .run(id, repository, "queued", now, now);
    return this.session(id);
  }
  session(id: string): Session {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as
      Record<string, string> | undefined;
    if (!r) throw new Error(`Unknown session ${id}`);
    return {
      schemaVersion: 1,
      id: r.id!,
      repository: r.repository!,
      status: r.status as TaskStatus,
      createdAt: r.created_at!,
      updatedAt: r.updated_at!,
    };
  }
  sessions(): Session[] {
    return (
      this.db
        .prepare("SELECT id FROM sessions ORDER BY created_at DESC LIMIT 100")
        .all() as { id: string }[]
    ).map((r) => this.session(r.id));
  }
  setStatus(id: string, status: TaskStatus) {
    this.db
      .prepare("UPDATE sessions SET status=?,updated_at=? WHERE id=?")
      .run(status, new Date().toISOString(), id);
  }
  append(
    sessionId: string,
    type: string,
    payload: unknown,
    taskId?: string,
  ): SessionEvent {
    return this.transaction(() => {
      this.session(sessionId);
      const r = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE session_id=?",
        )
        .get(sessionId) as { seq: number };
      const event: SessionEvent = {
        schemaVersion: 1,
        sessionId,
        sequence: r.seq,
        type,
        timestamp: new Date().toISOString(),
        payload,
        ...(taskId ? { taskId } : {}),
      };
      this.db
        .prepare("INSERT INTO events VALUES(?,?,?)")
        .run(sessionId, r.seq, JSON.stringify(event));
      return event;
    });
  }
  events(id: string, after = 0): SessionEvent[] {
    this.session(id);
    return (
      this.db
        .prepare(
          "SELECT event FROM events WHERE session_id=? AND seq>? ORDER BY seq",
        )
        .all(id, after) as { event: string }[]
    ).map((r) => JSON.parse(r.event));
  }
  saveCheckpoint(sessionId: string, taskId: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO checkpoints VALUES(?,?,?) ON CONFLICT(session_id,task_id) DO UPDATE SET value=excluded.value",
      )
      .run(sessionId, taskId, JSON.stringify(value));
  }
  checkpoint<T = unknown>(sessionId: string, taskId: string): T | undefined {
    const r = this.db
      .prepare("SELECT value FROM checkpoints WHERE session_id=? AND task_id=?")
      .get(sessionId, taskId) as { value: string } | undefined;
    return r ? JSON.parse(r.value) : undefined;
  }
  beginOperation(id: string, digest: string): "new" | "done" | "uncertain" {
    return this.transaction(() => {
      const r = this.db
        .prepare("SELECT * FROM operations WHERE id=?")
        .get(id) as { digest: string; state: string } | undefined;
      if (r) {
        if (r.digest !== digest) throw new Error("Operation digest mismatch");
        return r.state === "done" ? "done" : "uncertain";
      }
      this.db
        .prepare("INSERT INTO operations VALUES(?,?,?,NULL)")
        .run(id, digest, "started");
      return "new";
    });
  }
  finishOperation(id: string, result: unknown) {
    this.db
      .prepare("UPDATE operations SET state='done',result=? WHERE id=?")
      .run(JSON.stringify(result), id);
  }
  operationResult<T = unknown>(id: string): T | undefined {
    const r = this.db
      .prepare("SELECT result FROM operations WHERE id=? AND state='done'")
      .get(id) as { result: string } | undefined;
    return r ? JSON.parse(r.result) : undefined;
  }
  reserve(
    id: string,
    session: string,
    task: string,
    amount: number,
    limits: { task: number; session: number; daily: number },
  ) {
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error("Invalid usage estimate");
    this.transaction(() => {
      const existing = this.db
        .prepare("SELECT id FROM reservations WHERE id=?")
        .get(id);
      if (existing) throw new Error("Duplicate reservation");
      const day = new Date().toISOString().slice(0, 10);
      for (const [where, args, limit] of [
        ["session_id=? AND task_id=?", [session, task], limits.task],
        ["session_id=?", [session], limits.session],
        ["day=?", [day], limits.daily],
      ] as [string, string[], number][]) {
        const r = this.db
          .prepare(
            `SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE amount END),0) AS used FROM reservations WHERE ${where}`,
          )
          .get(...args) as { used: number };
        if (r.used + amount > limit)
          throw new Error(
            "Budget exhausted; approval required to raise the trusted limit",
          );
      }
      this.db
        .prepare("INSERT INTO reservations VALUES(?,?,?,?,NULL,?,?)")
        .run(id, session, task, amount, "reserved", day);
    });
  }
  settle(id: string, actual: number) {
    if (!Number.isFinite(actual) || actual < 0)
      throw new Error("Invalid usage cost");
    this.db
      .prepare("UPDATE reservations SET actual=?,state='settled' WHERE id=?")
      .run(actual, id);
  }
  spending(session: string): { settled: number; reserved: number } {
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE 0 END),0) AS settled,COALESCE(SUM(CASE WHEN state='reserved' THEN amount ELSE 0 END),0) AS reserved FROM reservations WHERE session_id=?",
      )
      .get(session);
    return r as { settled: number; reserved: number };
  }
  acquire(key: string, owner: string, ttlMs = 60000): boolean {
    return this.transaction(() => {
      const now = Date.now();
      this.db.prepare("DELETE FROM locks WHERE expires<?").run(now);
      return (
        Number(
          this.db
            .prepare("INSERT OR IGNORE INTO locks VALUES(?,?,?)")
            .run(key, owner, now + ttlMs).changes,
        ) === 1
      );
    });
  }
  renew(key: string, owner: string, ttlMs = 60000): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE locks SET expires=? WHERE key=? AND owner=? AND expires>=?",
          )
          .run(Date.now() + ttlMs, key, owner, Date.now()).changes,
      ) === 1
    );
  }
  release(key: string, owner: string) {
    this.db
      .prepare("DELETE FROM locks WHERE key=? AND owner=?")
      .run(key, owner);
  }
  close() {
    this.db.close();
  }
}
