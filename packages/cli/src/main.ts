#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig, credentials } from "../../core/src/config.js";
import { Journal } from "../../core/src/journal.js";
import { ArtifactStore } from "../../core/src/artifacts.js";
import { networkTools } from "../../core/src/network.js";
import { Controller } from "../../core/src/controller.js";
import { DockerSandbox } from "../../core/src/sandbox.js";
import { adapterFor, MockAdapter } from "../../providers/src/index.js";
import {
  type Capability,
  capabilitySchema,
  VERSION,
} from "../../core/src/contracts.js";
import { runProcess } from "../../core/src/process.js";
import { publishDraft } from "../../core/src/publication.js";
import { outputEvent, oneEvent, terminalText } from "./output.js";
const help = `TFVN Harness ${VERSION} (internal development build)\n\nUsage:\n  tfvn                         Interactive terminal\n  tfvn run "request"           Execute a request\n  tfvn resume <session>        Resume persisted work\n  tfvn status <session>        Inspect progress\n  tfvn departments             Department profiles\n  tfvn doctor [--live]          Check tools and provider setup\n\nOptions:\n  --json                       Versioned JSON events\n  --repo <path>                Repository (default: current directory)\n  --state <path>               Local journal/artifact directory\n  --config <path>              Trusted user settings\n  --allow edit,execute         Explicit capabilities for this run\n  --snapshot head|working      Tracked source policy (default: head)\n  --include <path>             Select an untracked file (repeatable)\n  --cloud                      Submit authorized snapshot to configured cloud\n  --pr                         Publish a verified branch and draft GitHub PR\n  --mock                       Offline read-only demonstration\n  --help / --version\n`;
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      repo: { type: "string" },
      state: { type: "string" },
      config: { type: "string" },
      allow: { type: "string" },
      snapshot: { type: "string" },
      include: { type: "string", multiple: true },
      cloud: { type: "boolean" },
      pr: { type: "boolean" },
      mock: { type: "boolean" },
      live: { type: "boolean" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });
  if (values.help || values.version) {
    process.stdout.write(
      values.json
        ? JSON.stringify(
            oneEvent("help", { text: values.version ? VERSION : help }),
          ) + "\n"
        : values.version
          ? VERSION + "\n"
          : help,
    );
    return;
  }
  if (values.cloud && values.pr)
    throw new Error(
      "Cloud results require local integration and verification before PR publication. Run --cloud, then apply and verify its returned patch locally.",
    );
  const command = positionals[0] ?? "interactive";
  if (
    ![
      "interactive",
      "run",
      "resume",
      "status",
      "departments",
      "doctor",
    ].includes(command)
  )
    throw new Error(`Unknown command ${command}`);
  if (
    (command === "run" && !positionals[1]) ||
    (["resume", "status"].includes(command) && !positionals[1])
  )
    throw new Error(
      `${command} requires ${command === "run" ? "a request" : "a session ID"}`,
    );
  const stateRoot = resolve(
    values.state ??
      process.env.TFVN_STATE_DIR ??
      join(homedir(), ".local", "state", "tfvn"),
  );
  const journal = new Journal(join(stateRoot, "sessions.sqlite"));
  let repository = resolve(values.repo ?? process.cwd());
  try {
    if (command === "resume" || command === "status")
      repository = journal.session(positionals[1]!).repository;
    const config = await readConfig(repository, values.config);
    const sandbox = new DockerSandbox(config.sandboxImage);
    const json = values.json ?? false;
    const single = (type: string, payload: unknown) => {
      const event = oneEvent(type, payload);
      if (json) outputEvent(event, true);
      else
        process.stdout.write(
          terminalText(JSON.stringify(payload, null, 2)) + "\n",
        );
    };
    if (command === "departments") {
      single("departments", { departments: Object.values(config.departments) });
      return;
    }
    if (command === "doctor") {
      const checks: any[] = [];
      for (const tool of ["git", "docker", "gh"]) {
        try {
          const r = await runProcess([tool, "--version"], { timeoutMs: 5000 });
          checks.push({
            name: tool,
            ok: r.exitCode === 0,
            detail: r.stdout.trim(),
          });
        } catch {
          checks.push({ name: tool, ok: false });
        }
      }
      checks.push({
        name: "sandbox image",
        ok: await sandbox.available(),
        detail: config.sandboxImage,
      });
      for (const provider of ["qwen", "openai", "anthropic"] as const) {
        const role = Object.values(config.departments).find(
          (d) => d.model.provider === provider,
        )!;
        const ep = config.providers[provider]!;
        let ok = !!process.env[ep.apiKeyEnv],
          detail = ok
            ? "Credentials configured; model access and quota untested"
            : `Set ${ep.apiKeyEnv}`;
        if (values.live && ok)
          try {
            const adapter = adapterFor(provider, {
              ...ep,
              apiKey: credentials(config, provider),
            });
            let finished = false;
            for await (const event of adapter.stream({
              model: role.model,
              system: "Reply OK.",
              messages: [{ role: "user", content: "Reply OK." }],
              tools: [],
              maxOutputTokens: 1024,
              signal: AbortSignal.timeout(30000),
            }))
              if (event.type === "finish") finished = true;
            ok = finished;
            detail = finished
              ? "Live model request completed"
              : "Live request incomplete";
          } catch (e) {
            ok = false;
            detail = String(e);
          }
        checks.push({
          name: provider,
          model: role.model.id,
          ok,
          liveTested: !!values.live,
          detail,
          pricingConfigured:
            ep.inputPerMillion !== undefined &&
            ep.outputPerMillion !== undefined,
        });
      }
      if (config.cloud) {
        try {
          const response = await fetch(new URL("/healthz", config.cloud.url), {
            signal: AbortSignal.timeout(5000),
          });
          checks.push({ name: "cloud", ok: response.ok });
        } catch {
          checks.push({ name: "cloud", ok: false });
        }
      }
      single("doctor", { checks });
      if (checks.some((c) => !c.ok)) process.exitCode = 2;
      return;
    }
    if (command === "status") {
      const id = positionals[1]!;
      const remote = journal.checkpoint<{ id: string; url: string }>(
        id,
        "remote",
      );
      if (remote) {
        const { CloudClient } = await import("../../cloud/src/client.js");
        if (!config.cloud) throw new Error("Cloud settings missing");
        single("status", {
          session: journal.session(id),
          remote: await new CloudClient(
            config.cloud.url,
            process.env[config.cloud.tokenEnv] ?? "",
          ).status(remote.id),
        });
      } else
        single("status", {
          session: journal.session(id),
          spending: journal.spending(id),
          result: journal.checkpoint<any>(id, "activeRun")?.result,
          events: journal.events(id).slice(-30),
        });
      return;
    }
    const grants: Capability[] = [
      ...new Set([
        "read" as const,
        ...(values.allow ?? "")
          .split(",")
          .filter(Boolean)
          .map((v) => capabilitySchema.parse(v)),
        ...(values.pr ? ["publish" as const] : []),
        ...(values.cloud ? ["upload" as const] : []),
      ]),
    ];
    if (values.snapshot && !["head", "working"].includes(values.snapshot))
      throw new Error("Snapshot must be head or working");
    const session =
      command === "resume"
        ? journal.session(positionals[1]!)
        : journal.createSession(repository);
    const onEvent = (event: Parameters<typeof outputEvent>[0]) =>
      outputEvent(event, json);
    const saved = journal.checkpoint<{ grants: Capability[]; mock: boolean }>(
      session.id,
      "options",
    );
    if (command === "resume" && saved && !values.allow)
      grants.push(...saved.grants.filter((c) => !grants.includes(c)));
    journal.saveCheckpoint(session.id, "options", {
      grants,
      mock: values.mock ?? saved?.mock ?? false,
    });
    const mock = values.mock ?? saved?.mock ?? false;
    if ((values.cloud || journal.checkpoint(session.id, "remote")) && !mock) {
      const { runCloud } = await import("../../cloud/src/client.js");
      await runCloud({
        repository,
        stateRoot,
        journal,
        session,
        config,
        request: positionals.slice(1).join(" "),
        grants,
        snapshot: {
          tracked: values.snapshot === "working" ? "working" : "head",
          untracked: values.include ?? [],
        },
        onEvent,
        resume: command === "resume",
      });
      return;
    }
    const controller = new Controller({
      repository,
      stateRoot,
      journal,
      artifacts: new ArtifactStore(join(stateRoot, "artifacts")),
      config,
      sandbox,
      adapter: (role) =>
        mock
          ? new MockAdapter()
          : adapterFor(role.model.provider, {
              ...config.providers[role.model.provider]!,
              apiKey: credentials(config, role.model.provider),
            }),
      grants,
      onEvent,
      mock,
      extensions: networkTools(config.allowedOrigins),
    });
    if (command === "interactive") {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error(
          'Interactive mode requires a terminal. Use tfvn run "request" --json for automation.',
        );
      const { terminal } = await import("./ui.js");
      await terminal(controller, session.id);
      return;
    }
    const event = journal.append(session.id, "session.opened", {
      repository,
      sessionId: session.id,
      mock,
    });
    onEvent(event);
    const abort = new AbortController();
    const cancel = () => abort.abort(new Error("cancelled"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const request =
        command === "resume" ? "" : positionals.slice(1).join(" ");
      if (request) journal.append(session.id, "message", { text: request });
      const result = await controller.execute(session.id, request, {
        signal: abort.signal,
        resume: command === "resume",
        snapshot: {
          tracked: values.snapshot === "working" ? "working" : "head",
          untracked: values.include ?? [],
        },
      });
      if (values.pr) {
        const url = await publishDraft(repository, result, journal);
        onEvent(journal.append(session.id, "publication.completed", { url }));
        if (!json) process.stdout.write(url + "\n");
      }
      if (result.status !== "completed")
        process.exitCode = result.status === "cancelled" ? 130 : 2;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  } finally {
    journal.close();
  }
}
main().catch((error) => {
  process.stderr.write(
    `tfvn: ${terminalText(error instanceof Error ? error.message : String(error))}\n`,
  );
  process.exitCode = 1;
});
