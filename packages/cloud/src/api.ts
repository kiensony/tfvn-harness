import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { digest, ArtifactStore } from "../../core/src/artifacts.js";
import {
  submissionSchema,
  type CloudStore,
  type Dispatcher,
  type Principal,
} from "./contracts.js";
import { validateSnapshot } from "./snapshot.js";
export class CloudApi {
  constructor(
    readonly store: CloudStore,
    readonly dispatcher: Dispatcher,
  ) {}
  async submit(actor: Principal, key: string, value: unknown) {
    if (!key || key.length > 200)
      throw new Error("An idempotency key is required");
    const submission = submissionSchema.parse(value);
    validateSnapshot(submission.snapshot);
    for (const capability of [
      "read",
      "upload",
      ...(submission.mode === "write" ? ["edit", "execute"] : []),
    ])
      if (!actor.capabilities.includes(capability as any))
        throw new Error(`Permission denied: ${capability}`);
    const run = await this.store.create(
      actor.id,
      key,
      digest(submission),
      submission,
    );
    if (run.status === "queued") await this.dispatcher.start(run.id);
    return run;
  }
  async get(actor: Principal, id: string) {
    const run = await this.store.get(actor.id, id);
    if (!run) throw new Error("Run not found");
    return run;
  }
  async cancel(actor: Principal, id: string) {
    await this.get(actor, id);
    await this.store.cancel(actor.id, id);
    await this.dispatcher.cancel(id);
    await this.store.append(id, "run.cancelled", {});
  }
  async steer(actor: Principal, id: string, text: string) {
    const run = await this.get(actor, id);
    if (!["queued", "running"].includes(run.status))
      throw new Error("Run is not active");
    const event = await this.store.append(id, "steering", {
      text: z.string().min(1).max(100000).parse(text),
    });
    if (!event) throw new Error("Run is not active");
    return event;
  }
  async approval(actor: Principal, key: string, value: unknown) {
    const a = z
      .object({
        actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
        scope: z.string().min(1).max(300),
        expiresAt: z.iso.datetime(),
      })
      .strict()
      .parse(value);
    if (!actor.capabilities.includes("publish"))
      throw new Error("Permission denied: publication approval");
    if (!key || key.length > 200)
      throw new Error("An idempotency key is required");
    if (
      Date.parse(a.expiresAt) <= Date.now() ||
      Date.parse(a.expiresAt) > Date.now() + 86400000
    )
      throw new Error("Approval validity must be within 24 hours");
    return this.store.approve(actor.id, key, {
      schemaVersion: 1,
      id: randomUUID(),
      actor: actor.id,
      ...a,
      createdAt: new Date().toISOString(),
    });
  }
}
export function cloudServer(
  api: CloudApi,
  tokens: Map<string, Principal>,
  artifacts?: ArtifactStore,
) {
  if (tokens.size === 0)
    throw new Error("At least one authenticated principal is required");
  return createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") {
        send(200, { status: "ok", schemaVersion: 1 });
        return;
      }
      const auth = req.headers.authorization ?? "";
      let actor: Principal | undefined;
      if (auth.startsWith("Bearer ")) {
        const given = createHash("sha256").update(auth.slice(7)).digest();
        for (const [token, p] of tokens)
          if (
            timingSafeEqual(given, createHash("sha256").update(token).digest())
          )
            actor = p;
      }
      if (!actor) {
        send(401, { error: "Unauthorized" });
        return;
      }
      const key = String(req.headers["idempotency-key"] ?? "");
      if (req.method === "POST" && url.pathname === "/v1/runs") {
        const run = await api.submit(actor, key, await body(req));
        send(202, publicRun(run));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/approvals") {
        send(201, await api.approval(actor, key, await body(req)));
        return;
      }
      const runMatch =
        /^\/v1\/runs\/([a-f0-9-]{36})(?:\/(events|steer|cancel))?$/.exec(
          url.pathname,
        );
      if (runMatch) {
        const id = runMatch[1]!,
          action = runMatch[2];
        const run = await api.get(actor, id);
        if (req.method === "GET" && !action) {
          send(200, publicRun(run));
          return;
        }
        if (req.method === "GET" && action === "events") {
          const after = Number(url.searchParams.get("after") ?? "0");
          if (!Number.isSafeInteger(after) || after < 0)
            throw new Error("Invalid event cursor");
          send(200, {
            schemaVersion: 1,
            events: await api.store.events(actor.id, id, after),
          });
          return;
        }
        if (req.method === "POST" && action === "cancel") {
          await api.cancel(actor, id);
          send(202, { status: "cancelled" });
          return;
        }
        if (req.method === "POST" && action === "steer") {
          const data = (await body(req)) as any;
          send(202, await api.steer(actor, id, data.text));
          return;
        }
      }
      const artifactMatch = /^\/v1\/artifacts\/([a-f0-9]{64})$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && artifactMatch && artifacts) {
        const id = artifactMatch[1]!,
          runId = url.searchParams.get("run") ?? "";
        const run = await api.get(actor, runId);
        if (!run.result?.artifacts.includes(id)) {
          send(404, { error: "Artifact not found" });
          return;
        }
        const data = await artifacts.get(id);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": data.length,
          "cache-control": "no-store",
        });
        res.end(data);
        return;
      }
      send(404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not found/i.test(message)
        ? 404
        : /Permission/.test(message)
          ? 403
          : /idempotency/i.test(message)
            ? 409
            : error instanceof z.ZodError ||
                /Invalid|Unsafe|integrity|required|validity|exceeds|not active/.test(
                  message,
                )
              ? 400
              : 503;
      send(status, {
        error:
          status === 503
            ? "Service unavailable; retry with the same idempotency key"
            : message,
      });
    }
  });
}
function publicRun(run: Awaited<ReturnType<CloudApi["get"]>>) {
  return {
    schemaVersion: 1,
    id: run.id,
    status: run.status,
    generation: run.generation,
    createdAt: run.createdAt,
    result: run.result,
    repositoryKey: run.submission.repositoryKey,
  };
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 48_000_000) throw new Error("Request exceeds body limit");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Error("Invalid JSON body");
  }
}
