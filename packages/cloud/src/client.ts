import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { type Config } from "../../core/src/config.js";
import { type Journal } from "../../core/src/journal.js";
import {
  type Session,
  type SessionEvent,
  type Capability,
} from "../../core/src/contracts.js";
import {
  WorkspaceService,
  type SnapshotPolicy,
} from "../../core/src/workspace.js";
import { digest, ArtifactStore } from "../../core/src/artifacts.js";
import { exportSnapshot } from "./snapshot.js";
import { type Submission } from "./contracts.js";
export class CloudClient {
  constructor(
    readonly url: string,
    readonly token: string,
  ) {
    const u = new URL(url);
    if (
      u.protocol !== "https:" &&
      !(
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
        u.protocol === "http:"
      )
    )
      throw new Error("Cloud endpoint must use HTTPS");
    if (!token) throw new Error("Cloud token is missing");
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
  ): Promise<any> {
    const r = await fetch(new URL(path, this.url), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!r.ok)
      throw new Error(
        `Cloud HTTP ${r.status}: ${(await r.text()).slice(0, 1000)}`,
      );
    return r.json();
  }
  submit(key: string, payload: Submission) {
    return this.request("/v1/runs", "POST", payload, key);
  }
  status(id: string) {
    return this.request(`/v1/runs/${encodeURIComponent(id)}`);
  }
  async events(id: string, after = 0): Promise<SessionEvent[]> {
    return (
      await this.request(
        `/v1/runs/${encodeURIComponent(id)}/events?after=${after}`,
      )
    ).events;
  }
  cancel(id: string) {
    return this.request(
      `/v1/runs/${encodeURIComponent(id)}/cancel`,
      "POST",
      {},
    );
  }
  steer(id: string, text: string) {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/steer`, "POST", {
      text,
    });
  }
  async artifact(id: string, run: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid artifact ID");
    const r = await fetch(
      new URL(`/v1/artifacts/${id}?run=${encodeURIComponent(run)}`, this.url),
      {
        headers: { authorization: `Bearer ${this.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!r.ok) throw new Error(`Artifact HTTP ${r.status}`);
    const data = Buffer.from(await r.arrayBuffer());
    if (digest(data) !== id) throw new Error("Artifact integrity failure");
    return data;
  }
}
export async function runCloud(options: {
  repository: string;
  stateRoot: string;
  journal: Journal;
  session: Session;
  config: Config;
  request: string;
  grants: Capability[];
  snapshot: SnapshotPolicy;
  onEvent: (event: SessionEvent) => void;
  resume: boolean;
}) {
  const o = options;
  if (!o.config.cloud)
    throw new Error("Configure a trusted cloud endpoint before using --cloud");
  const client = new CloudClient(
    o.config.cloud.url,
    process.env[o.config.cloud.tokenEnv] ?? "",
  );
  let remote = o.journal.checkpoint<{
    id: string;
    url: string;
    cursor: number;
  }>(o.session.id, "remote");
  const emit = (type: string, payload: unknown) =>
    o.onEvent(o.journal.append(o.session.id, type, payload));
  if (!remote) {
    if (!o.grants.includes("upload"))
      throw new Error("Snapshot upload is not authorized");
    let submission = o.journal.checkpoint<{ key: string; payload: Submission }>(
      o.session.id,
      "cloudSubmission",
    );
    if (!submission) {
      const service = new WorkspaceService(
        o.repository,
        join(o.stateRoot, "workspaces"),
        o.config.project.secretPaths,
      );
      const snapshot = await service.snapshot(o.snapshot);
      emit("snapshot", {
        id: snapshot.id,
        base: snapshot.base,
        manifest: snapshot.manifest,
      });
      submission = {
        key: randomUUID(),
        payload: {
          schemaVersion: 1,
          request: o.request,
          repositoryKey: digest(o.repository),
          mode: o.grants.includes("edit") ? "write" : "read",
          snapshot: await exportSnapshot(o.repository, snapshot),
        },
      };
      o.journal.saveCheckpoint(o.session.id, "cloudSubmission", submission);
    }
    const submitted = await client.submit(submission.key, submission.payload);
    remote = { id: submitted.id, url: o.config.cloud.url, cursor: 0 };
    o.journal.saveCheckpoint(o.session.id, "remote", remote);
    emit("cloud.submitted", { runId: remote.id });
  }
  if (remote.url !== o.config.cloud.url)
    throw new Error("Remote session endpoint changed");
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      const events = await client.events(remote.id, remote.cursor);
      for (const event of events) {
        if (event.sequence <= remote.cursor) continue;
        remote.cursor = event.sequence;
        o.journal.saveCheckpoint(o.session.id, "remote", remote);
        emit(event.type, {
          ...(event.payload as object),
          remoteSequence: event.sequence,
        });
      }
      const status = await client.status(remote.id);
      if (
        ["completed", "cancelled", "blocked", "failed"].includes(status.status)
      ) {
        const local = new ArtifactStore(join(o.stateRoot, "artifacts"));
        for (const id of status.result?.artifacts ?? [])
          await local.put(await client.artifact(id, remote.id));
        o.journal.setStatus(o.session.id, status.status);
        emit("cloud.completed", { ...status, artifactDirectory: local.root });
        if (status.status !== "completed") process.exitCode = 2;
        return;
      }
      await delay(1000);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  emit("cloud.disconnected", {
    runId: remote.id,
    message: "Remote work continues. Resume this session to reconnect.",
  });
}
