import { Context } from "@temporalio/activity";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { PostgresAdmission, AdmittedAdapter } from "./admission.js";
import { PostgresCloudStore } from "./store.js";
import { type CloudStore } from "./contracts.js";
import { materializeSnapshot } from "./snapshot.js";
import { type Sandbox } from "../../core/src/sandbox.js";
import { Controller } from "../../core/src/controller.js";
import { Journal } from "../../core/src/journal.js";
import { type ArtifactStore } from "../../core/src/artifacts.js";
import { readConfig, credentials } from "../../core/src/config.js";
import { adapterFor } from "../../providers/src/index.js";
import { git } from "../../core/src/workspace.js";
import { type TaskResult } from "../../core/src/contracts.js";
export interface Activities {
  executeRun(runId: string): Promise<boolean>;
}
export function createActivities(
  store: CloudStore,
  root: string,
  artifacts: ArtifactStore,
  sandbox: Sandbox,
): Activities {
  return {
    executeRun: async (runId) => {
      const ctx = Context.current(),
        abort = new AbortController();
      const signal = AbortSignal.any([ctx.cancellationSignal, abort.signal]);
      const span = trace
        .getTracer("tfvn")
        .startSpan("cloud.run", { attributes: { "tfvn.run.id": runId } });
      const run = await store.claim(runId, Date.now(), 30000);
      if (!run) {
        const existing = await store.internalGet(runId);
        span.end();
        return !existing || !["queued", "running"].includes(existing.status);
      }
      const generation = run.generation;
      let cursor = 0,
        steeringSequence = 0,
        steeringReads = Promise.resolve(),
        eventWrites = Promise.resolve(),
        pumping = false;
      const readSteering = async () => {
        const messages: string[] = [];
        const read = steeringReads.then(async () => {
          while (true) {
            const events = await store.events(run.owner, runId, cursor);
            for (const e of events) {
              cursor = e.sequence;
              if (e.type === "steering") {
                messages.push((e.payload as { text: string }).text);
                steeringSequence = e.sequence;
              }
            }
            if (events.length < 1000) break;
          }
        });
        steeringReads = read.catch(() => {});
        await read;
        return messages;
      };
      const timer = setInterval(() => {
        if (pumping) return;
        pumping = true;
        void (async () => {
          ctx.heartbeat({ generation });
          if (!(await store.heartbeat(runId, generation, Date.now(), 30000)))
            throw new Error("Lost worker generation lease");
        })()
          .catch((e) => abort.abort(e))
          .finally(() => {
            pumping = false;
          });
      }, 5000);
      timer.unref();
      const state = join(root, runId, `generation-${generation}`),
        repo = join(state, "source");
      let journal: Journal | undefined;
      try {
        await materializeSnapshot(run.submission.snapshot, repo);
        await git(repo, ["init", "-q"]);
        await git(repo, ["add", "--all"]);
        await git(repo, [
          "-c",
          "user.name=TFVN",
          "-c",
          "user.email=tfvn@localhost",
          "commit",
          "--allow-empty",
          "-m",
          "Uploaded source snapshot",
        ]);
        const config = await readConfig(repo);
        config.limits.modifyingPerRepo = 1; // One sandbox at a time per admitted cloud activity.
        const ledger =
          store instanceof PostgresCloudStore
            ? new PostgresAdmission(store.pool, runId, generation, {
                run: config.limits.taskDollars,
                daily: config.limits.dailyDollars,
                requestsPerMinute: Number(process.env.TFVN_PROVIDER_RPM ?? 60),
                tokensPerMinute: Number(
                  process.env.TFVN_PROVIDER_TPM ?? 1000000,
                ),
              })
            : undefined;
        journal = new Journal(join(state, "sessions.sqlite"));
        const session = journal.createSession(repo, runId);
        const controller = new Controller({
          repository: repo,
          stateRoot: state,
          journal,
          artifacts,
          config,
          sandbox,
          grants:
            run.submission.mode === "write"
              ? ["read", "edit", "execute"]
              : ["read"],
          adapter: (role) => {
            const adapter = adapterFor(role.model.provider, {
              ...config.providers[role.model.provider]!,
              apiKey: credentials(config, role.model.provider),
            });
            return ledger ? new AdmittedAdapter(adapter, ledger) : adapter;
          },
          onEvent: (event) => {
            eventWrites = eventWrites
              .then(async () => {
                const accepted = await store.append(
                  runId,
                  event.type,
                  event.payload,
                  generation,
                );
                if (!accepted)
                  abort.abort(
                    new Error("Worker generation is no longer current"),
                  );
              })
              .catch((e) => abort.abort(e));
          },
        });
        let resume = false;
        while (true) {
          const result = await controller.execute(
            session.id,
            run.submission.request,
            { signal, resume, steering: readSteering },
          );
          if (result.workspace && result.revision) {
            const base =
              result.checks[0]?.identity.base ??
              (await git(repo, ["rev-parse", "HEAD"])).trim();
            const patch = await git(result.workspace, [
              "diff",
              "--binary",
              "--no-ext-diff",
              "--no-textconv",
              base,
              result.revision,
            ]);
            const artifact = await artifacts.put(patch);
            result.artifacts.push(artifact);
            result.summary += `\nReturned patch artifact: ${artifact}. Original source base: ${run.submission.snapshot.base}. Apply in a local review workspace and reverify the integrated revision before publication.`;
          }
          // Remote filesystem paths are not usable delivery paths on the client.
          delete result.workspace;
          delete result.branch;
          await eventWrites;
          if (
            !(await store.finish(
              runId,
              generation,
              result,
              Date.now(),
              steeringSequence,
            ))
          ) {
            const current = await store.internalGet(runId);
            if (
              !current ||
              current.generation !== generation ||
              current.status !== "running" ||
              current.leaseUntil < Date.now()
            )
              throw new Error("Stale worker result rejected");
            // A message raced with finalization. Resume through the coordinator;
            // it invalidates prior evidence before acknowledging the new message.
            resume = true;
            continue;
          }
          await store.append(runId, "cloud.finalized", {
            status: result.status,
            artifacts: result.artifacts,
          });
          break;
        }
      } catch (e) {
        span.recordException(e instanceof Error ? e : new Error(String(e)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        const result: TaskResult = {
          schemaVersion: 1,
          id: runId,
          status: signal.aborted ? "cancelled" : "blocked",
          summary: String(e),
          artifacts: [],
          checks: [],
          reviews: [],
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          blockers: [String(e)],
        };
        await eventWrites;
        const accepted = await store.finish(
          runId,
          generation,
          result,
          Date.now(),
          steeringSequence,
        );
        if (!accepted && (await store.internalGet(runId))?.status === "running")
          throw e;
        if (ctx.cancellationSignal.aborted) throw e;
      } finally {
        clearInterval(timer);
        journal?.close();
        span.end();
      }
      return true;
    },
  };
}
