import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  assessmentSchema,
  deliveryGate,
  routeSchema,
  VERSION,
  type Capability,
  type CheckRun,
  type DepartmentSpec,
  type EvidenceIdentity,
  type ReviewVerdict,
  type RouteDecision,
  type SessionEvent,
  type TaskResult,
  type TaskSpec,
  type Usage,
} from "./contracts.js";
import { type ModelAdapter } from "./model.js";
import { type Config } from "./config.js";
import { dispatch, validateRoute } from "./departments.js";
import { ArtifactStore, digest } from "./artifacts.js";
import { Journal } from "./journal.js";
import { ToolBroker, PermissionPolicy } from "./tools.js";
import { type Sandbox } from "./sandbox.js";
import { AgentRuntime, type AgentOutput } from "./runtime.js";
import {
  WorkspaceService,
  git,
  type Snapshot,
  type SnapshotPolicy,
  type Workspace,
} from "./workspace.js";
import { safePath } from "./paths.js";
import { type ExtensionRegistry } from "./extensions.js";

interface GraphNode {
  id: string;
  dependencies: string[];
}
interface ObservedCommand {
  exitCode: number | null;
  status: CheckRun["status"];
  log: string;
}
class IntegrationConflict extends Error {
  constructor(
    readonly conflicts: string[],
    readonly workspace: Workspace,
    readonly revision: string,
  ) {
    super(`Integration conflict: ${conflicts.join(", ")}`);
    this.name = "IntegrationConflict";
  }
}
function changeRequested(text: string): boolean {
  return (
    /\b(implement|build|fix|change|update|write|create|apply)\b/i.test(text) &&
    !/\b(propose|explain|describe|investigate|inspect|discuss|suggest)\b/i.test(
      text,
    ) &&
    !/\bdesign only\b/i.test(text)
  );
}
function logTail(log: string): string {
  const bytes = Buffer.from(log);
  return bytes.length <= 16000
    ? log
    : bytes.subarray(bytes.length - 16000).toString("utf8");
}
function globMatch(path: string, glob: string): boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${pattern}$`).test(path);
}
export function conventionTest(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    /\.test\.[^/]+$/.test(name) ||
    /\.spec\.[^/]+$/.test(name) ||
    /^test_.+\.py$/.test(name) ||
    /_test\.py$/.test(name) ||
    path.split("/").some((part) => part === "tests" || part === "__tests__")
  );
}
export function baselineTestPaths(
  files: { path: string; hash: string }[],
  globs: string[] = [],
): { path: string; hash: string }[] {
  return files.filter(
    (file) =>
      conventionTest(file.path) ||
      globs.some((glob) => globMatch(file.path, glob)),
  );
}
function acceptanceCommand(
  directory: string,
  files: { path: string }[],
): string[] {
  const paths = files.map((file) => `${directory}/${file.path}`);
  if (files.every((file) => file.path.endsWith(".py")))
    return ["python3", "-m", "unittest", "-v", ...paths];
  if (files.every((file) => /\.(?:test|spec)\.(?:ts|js)$/.test(file.path)))
    return ["node", "--test", ...paths];
  throw new Error("unsupported acceptance runner");
}
async function installAcceptance(
  root: string,
  directory: string,
  files: { path: string; content: string }[],
) {
  for (const file of files) {
    const target = await safePath(root, `${directory}/${file.path}`, {
      create: true,
    });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { flag: "wx" });
  }
}
export function validateGraph<T extends GraphNode>(tasks: T[]): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (byId.size !== tasks.length) throw new Error("Duplicate task ID");
  const visited = new Set<string>(),
    active = new Set<string>(),
    ordered: T[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (active.has(id)) throw new Error("Task graph contains a cycle");
    const t = byId.get(id);
    if (!t) throw new Error(`Unknown dependency ${id}`);
    active.add(id);
    for (const d of t.dependencies) visit(d);
    active.delete(id);
    visited.add(id);
    ordered.push(t);
  };
  for (const t of tasks) visit(t.id);
  return ordered;
}
export async function runGraph<T extends GraphNode, R>(
  tasks: T[],
  concurrency: number,
  run: (task: T) => Promise<R>,
): Promise<Map<string, R>> {
  validateGraph(tasks);
  if (concurrency < 1) throw new Error("Invalid concurrency");
  const done = new Map<string, R>(),
    pending = new Map(tasks.map((t) => [t.id, t]));
  while (pending.size) {
    const ready = [...pending.values()]
      .filter((t) => t.dependencies.every((d) => done.has(d)))
      .slice(0, concurrency);
    if (!ready.length) throw new Error("Unsatisfied dependencies");
    const results = await Promise.allSettled(
      ready.map(async (t) => [t.id, await run(t)] as const),
    );
    let error: unknown;
    for (const result of results)
      if (result.status === "fulfilled") {
        done.set(...result.value);
        pending.delete(result.value[0]);
      } else error ??= result.reason;
    if (error) throw error;
  }
  return done;
}
const planSchema = z
  .object({
    criteria: z
      .array(
        z.object({ id: z.string().min(1), text: z.string().min(1) }).strict(),
      )
      .min(1),
    tasks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
            department: z.enum(["dev", "designer", "docs", "devops", "test"]),
            dependencies: z.array(z.string()),
            instructions: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(24),
  })
  .strict();
type Plan = z.infer<typeof planSchema>;
const qaPlanSchema = z
  .object({
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            criterion: z.string().min(1),
            description: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    files: z
      .array(
        z
          .object({
            path: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
            content: z.string().max(128000),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    command: z.array(z.string()).max(128).optional(),
  })
  .strict();

interface RunState {
  id: string;
  request: string;
  configDigest: string;
  context: string;
  route?: RouteDecision;
  plan?: Plan;
  qaPlan?: z.infer<typeof qaPlanSchema>;
  snapshot?: Snapshot;
  workspace?: Workspace;
  revision?: string;
  round: number;
  checks: CheckRun[];
  reviews: ReviewVerdict[];
  artifacts: string[];
  usage: Usage;
  handoffs: Record<string, string>;
  inputs: Record<string, { prompt: string; extra: string; workspace: string }>;
  tasks: Record<string, { workspace: Workspace; revision?: string }>;
  baselineTests?: { path: string; hash: string }[];
  qaVerified?: boolean;
  qaBaselineLog?: string;
  conflicts?: string[];
  pendingMessages?: string[];
  continuation?: { workspace: Workspace; base: string };
  inspectionWorkspace?: Workspace;
  result?: TaskResult;
}
export interface ControllerOptions {
  repository: string;
  stateRoot: string;
  journal: Journal;
  artifacts: ArtifactStore;
  config: Config;
  sandbox: Sandbox;
  adapter: (role: DepartmentSpec) => ModelAdapter;
  grants: Capability[];
  onEvent?: (event: SessionEvent) => void;
  mock?: boolean;
  extensions?: ExtensionRegistry;
}
export class Controller {
  constructor(readonly options: ControllerOptions) {}
  private emit(session: string, type: string, payload: unknown) {
    const event = this.options.journal.append(session, type, payload);
    this.options.onEvent?.(event);
  }
  async execute(
    sessionId: string,
    request: string,
    opts: {
      signal?: AbortSignal;
      resume?: boolean;
      snapshot?: SnapshotPolicy;
      steering?: () => string[] | Promise<string[]>;
    } = {},
  ): Promise<TaskResult> {
    const o = this.options,
      j = o.journal;
    const session = j.session(sessionId);
    if (session.repository !== o.repository)
      throw new Error("Session belongs to another repository");
    const abort = new AbortController();
    const signal = AbortSignal.any([
      opts.signal ?? new AbortController().signal,
      abort.signal,
    ]);
    let state = j.checkpoint<RunState>(sessionId, "activeRun");
    if (
      opts.resume &&
      state?.configDigest !== undefined &&
      state.configDigest !== digest(o.config)
    )
      throw new Error(
        "Configuration changed; start a new run so prior evidence cannot be reused",
      );
    if (opts.resume && state?.result?.status === "completed" && opts.steering) {
      const owner = randomUUID();
      if (!j.acquire(`session:${sessionId}`, owner))
        throw new Error("Session is already running");
      try {
        const messages = (await opts.steering()).filter((text) => text.trim());
        if (messages.length) {
          state.pendingMessages = [
            ...(state.pendingMessages ?? []),
            ...messages,
          ];
          state.checks = [];
          state.reviews = [];
          j.saveCheckpoint(sessionId, "activeRun", state);
          this.emit(sessionId, "evidence.invalidated", {
            reason: "New user instructions",
            messages,
          });
        }
      } finally {
        j.release(`session:${sessionId}`, owner);
      }
    }
    const superseded =
      opts.resume && state?.pendingMessages?.length ? state : undefined;
    if (superseded) request = superseded.pendingMessages!.at(-1)!;
    if (opts.resume && !superseded && state?.result?.status === "completed") {
      this.emit(sessionId, "run.completed", state.result);
      return state.result;
    }
    if (!opts.resume || !state || superseded) {
      state = {
        id: randomUUID(),
        request,
        configDigest: digest(o.config),
        context: await this.context(sessionId),
        round: 0,
        checks: [],
        reviews: [],
        artifacts: [],
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        handoffs: {},
        inputs: {},
        tasks: {},
      };
      if (superseded) {
        state.context += `\nContinue the user's active task unless the latest message changes its scope. Previous request: ${superseded.request}\nUser updates in order: ${JSON.stringify(superseded.pendingMessages)}\nPrior workspaces and handoffs: ${JSON.stringify({ tasks: superseded.tasks, handoffs: superseded.handoffs })}`;
        if (superseded.workspace && superseded.snapshot) {
          state.continuation = {
            workspace: superseded.workspace,
            base: superseded.snapshot.base,
          };
          state.inspectionWorkspace = superseded.workspace;
        }
      }
    } else {
      if (state.configDigest !== digest(o.config))
        throw new Error(
          "Configuration changed; start a new run so prior evidence cannot be reused",
        );
      request = state.request;
      delete state.result;
    }
    const s = state;
    s.inputs ??= {};
    const save = () => j.saveCheckpoint(sessionId, "activeRun", s);
    const inspectRoot = s.inspectionWorkspace?.path ?? o.repository;
    const readSteering = async (): Promise<string[]> => {
      const messages =
        (await opts.steering?.())?.filter((text) => text.trim()) ?? [];
      if (messages.length) {
        s.pendingMessages = [...(s.pendingMessages ?? []), ...messages];
        s.checks = [];
        s.reviews = [];
        save();
        this.emit(sessionId, "evidence.invalidated", {
          reason: "New user instructions",
          messages,
        });
        abort.abort(
          new Error(
            "New user instructions require routing and fresh acceptance criteria",
          ),
        );
      }
      signal.throwIfAborted();
      return [];
    };
    const workspaces = new WorkspaceService(
      o.repository,
      join(o.stateRoot, "workspaces"),
      o.config.project.secretPaths,
    );
    const perform = async (
      department: string,
      id: string,
      prompt: string,
      workspace = inspectRoot,
      extra = "",
      readOnly = true,
    ): Promise<AgentOutput> => {
      await readSteering();
      const role = o.config.departments[department];
      if (!role) throw new Error(`Unknown department ${department}`);
      const captured = s.inputs[id];
      if (captured) {
        prompt = captured.prompt;
        extra = captured.extra;
        workspace = captured.workspace;
      }
      if (
        readOnly &&
        workspace === inspectRoot &&
        o.grants.includes("execute") &&
        role.capabilities.includes("execute")
      ) {
        const key = `readonly-${id}`;
        if (!s.tasks[key]) {
          const isolated =
            s.snapshot ??
            (await workspaces.snapshot(
              opts.snapshot ?? { tracked: "head", untracked: [] },
            ));
          s.tasks[key] = { workspace: await workspaces.create(isolated, key) };
          save();
        }
        workspace = s.tasks[key]!.workspace.path;
      }
      if (!captured) {
        s.inputs[id] = { prompt, extra, workspace };
        save();
      }
      const scoped: DepartmentSpec = {
        ...role,
        capabilities: readOnly
          ? role.capabilities.filter((c) => c !== "edit")
          : role.capabilities,
        instructions: role.instructions + "\n" + extra,
      };
      const task: TaskSpec = {
        schemaVersion: 1,
        id: `${s.id}:${id}`,
        sessionId,
        department,
        request: prompt,
        dependencies: [],
        snapshot: s.snapshot?.id ?? "repository-readonly",
        requirements: digest(s.plan?.criteria ?? request),
        permissions: o.grants,
        budget: {
          dollars: o.config.limits.taskDollars,
          steps: o.config.limits.steps,
          durationMs: o.config.limits.durationMs,
          maxOutputTokens: o.config.limits.maxOutputTokens,
        },
        placement: "local",
        generation: 1,
      };
      const broker = new ToolBroker(
        workspace,
        new PermissionPolicy(o.grants),
        o.artifacts,
        o.sandbox,
        {
          secretPaths: o.config.project.secretPaths,
          readOnly,
          onCommand: (data) =>
            this.emit(sessionId, "command.started", {
              department,
              ...(data as object),
            }),
        },
        o.extensions,
      );
      const runtime = new AgentRuntime({
        journal: j,
        artifacts: o.artifacts,
        broker,
        adapter: o.adapter(scoped),
        limits: {
          task: o.config.limits.taskDollars,
          session: o.config.limits.sessionDollars,
          daily: o.config.limits.dailyDollars,
        },
        onEvent: o.onEvent,
      });
      this.emit(sessionId, "handoff", {
        department,
        taskId: id,
        workspace,
        dependencies: [],
        requirements: task.requirements,
      });
      const result = await runtime.run(task, scoped, {
        signal,
        context: s.context,
        steering: readSteering,
      });
      await readSteering();
      if (!s.handoffs[id]) {
        s.usage.inputTokens += result.usage.inputTokens;
        s.usage.outputTokens += result.usage.outputTokens;
        s.usage.cost += result.usage.cost;
        s.artifacts.push(...result.artifacts);
        s.handoffs[id] = result.text;
        save();
      }
      return result;
    };
    const structured = async <T>(
      phase: string,
      department: string,
      id: string,
      prompt: string,
      workspace: string,
      extra: string,
      parse: (text: string) => T,
      readOnly = true,
    ): Promise<{ value: T; artifacts: string[] }> => {
      const first = await perform(
        department,
        id,
        prompt,
        workspace,
        extra,
        readOnly,
      );
      try {
        return { value: parse(first.text), artifacts: first.artifacts };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const second = await perform(
          department,
          `${id}-correction`,
          prompt,
          workspace,
          `${extra}\nPrevious reply rejected: ${message}. Return one JSON value and no second document.`,
          readOnly,
        );
        try {
          return {
            value: parse(second.text),
            artifacts: [...first.artifacts, ...second.artifacts],
          };
        } catch {
          throw new Error(
            `Department did not return valid structured JSON (${phase})`,
          );
        }
      }
    };
    const ensureQa = async () => {
      if (s.route!.workflow === "small" || s.qaVerified) return;
      const directory = `.tfvn-qa/${s.id}`;
      if (!s.tasks["qa-baseline"]) {
        s.tasks["qa-baseline"] = {
          workspace: await workspaces.create(s.snapshot!, "qa-baseline"),
        };
        save();
      }
      const baseline = s.tasks["qa-baseline"].workspace;
      for (let attempt = 0; attempt < 2 && !s.qaVerified; attempt++) {
        if (!s.qaPlan) {
          const output = await perform(
            "qa",
            attempt === 0 ? "qa-strategy" : "qa-strategy-retry",
            `Derive independent executable acceptance tests from the request and repository baseline before trusting implementation claims. Request: ${request}\nCriteria: ${JSON.stringify(s.plan!.criteria)}`,
            baseline.path,
            `QA PLAN CONTRACT: Return ONLY JSON matching ${JSON.stringify(z.toJSONSchema(qaPlanSchema))}. File paths are simple filenames ending in .test.js, .spec.js, .test.ts, .spec.ts, or .py. The controller chooses and runs the test runner.\nAcceptance directory: ${directory}${
              attempt
                ? `\nPrevious acceptance passed on the baseline and was rejected:\n${(s.qaBaselineLog ?? "").slice(-16000)}`
                : ""
            }`,
          );
          const plan = qaPlanSchema.parse(parseJson(output.text));
          if (
            plan.cases.some(
              (c) => !s.plan!.criteria.some((a) => a.id === c.criterion),
            )
          )
            throw new Error(
              "QA case references an unknown acceptance criterion",
            );
          s.qaPlan = {
            ...plan,
            command: acceptanceCommand(directory, plan.files),
          };
          save();
        }
        const command = s.qaPlan?.command;
        if (!s.qaPlan || !command?.length)
          throw new Error("unsupported acceptance runner");
        const probe = await workspaces.create(
          s.snapshot!,
          `qa-probe-${attempt}`,
        );
        try {
          await installAcceptance(probe.path, directory, s.qaPlan.files);
          const observed = await this.runObserved(
            sessionId,
            probe,
            "qa-baseline-probe",
            command,
            signal,
            { readOnly: true, timeoutMs: 300000 },
          );
          if (observed.status === "unavailable")
            throw new Error(
              `Independent QA baseline probe unavailable: ${observed.log}`,
            );
          if (observed.exitCode !== 0) {
            s.qaVerified = true;
            s.artifacts.push(await o.artifacts.put(JSON.stringify(s.qaPlan)));
            save();
            return;
          }
          s.qaBaselineLog = observed.log;
          s.qaPlan = undefined;
          save();
        } finally {
          await workspaces.discard(probe);
        }
      }
      throw new Error("Independent QA tests already pass on the baseline");
    };
    const lockOwner = randomUUID();
    if (!j.acquire(`session:${sessionId}`, lockOwner))
      throw new Error("Session is already running");
    const renew = setInterval(() => {
      if (!j.renew(`session:${sessionId}`, lockOwner))
        abort.abort(new Error("Lost session lease"));
    }, 15000);
    renew.unref();
    try {
      save();
      j.setStatus(sessionId, "running");
      if (s.continuation && !s.snapshot) {
        await workspaces.assertMetadata(s.continuation.workspace);
        await workspaces.commit(
          s.continuation.workspace,
          "TFVN: preserve work before new instructions",
        );
        const source = new WorkspaceService(
          s.continuation.workspace.path,
          workspaces.root,
          o.config.project.secretPaths,
        );
        const snapshot = await source.snapshot({
          tracked: "head",
          untracked: [],
        });
        s.snapshot = {
          ...snapshot,
          base: s.continuation.base,
          id: digest({ snapshot: snapshot.id, base: s.continuation.base }),
        };
        delete s.continuation;
        save();
      }
      this.emit(sessionId, "run.started", {
        id: s.id,
        request,
        resumed: !!opts.resume,
      });
      const dispatchResult = dispatch(request, "user", o.config.departments);
      const readOnlyOwner =
        [
          "qa",
          "review",
          "planner",
          "architect",
          "security",
          "research",
        ].includes(dispatchResult.owner) || dispatchResult.command === "plan";
      if (
        !readOnlyOwner &&
        changeRequested(dispatchResult.text) &&
        (!o.grants.includes("edit") || !o.grants.includes("execute"))
      )
        throw new Error("Permission denied: edit, execute");
      if (!s.route) {
        if (o.mock)
          s.route = {
            schemaVersion: 1,
            owner: dispatchResult.owner,
            collaborators: dispatchResult.departments.filter(
              (d) => d !== dispatchResult.owner,
            ),
            workflow: "readonly",
            outcome: request,
            scope: "read",
            risks: [],
            placement: "local",
            clarifications: [],
            artifacts: [],
          };
        else {
          const routed = await structured(
            "route",
            "assistant",
            "route",
            request,
            inspectRoot,
            `ROUTING CONTRACT: Inspect repository evidence using read tools, then return ONLY a JSON object matching this schema: ${JSON.stringify(z.toJSONSchema(routeSchema))}. The deterministic owner is ${dispatchResult.owner}. Explicit departments: ${dispatchResult.departments.join(", ")}. Preserve requested scope. Read-only hint: ${dispatchResult.readonlyHint}. Do not implement. Any security, public API, migration or critical infrastructure change requires sensitive workflow. Use feature for substantial changes. Placement local unless cloud was explicitly authorized.`,
            (text) =>
              validateRoute(
                dispatchResult,
                parseJson(text),
                o.config.departments,
              ),
          );
          s.route = routed.value;
        }
        save();
        this.emit(sessionId, "route", s.route);
      }
      if (
        !readOnlyOwner &&
        changeRequested(dispatchResult.text) &&
        (s.route.scope !== "write" || s.route.workflow === "readonly")
      )
        throw new Error("Requested scope is read-only");
      if (s.route.clarifications.length)
        throw new Error(
          `Clarification required: ${s.route.clarifications.join("; ")}`,
        );
      if (s.route.placement === "cloud")
        throw new Error(
          "Route requires cloud execution; submit an authorized snapshot with --cloud",
        );
      if (s.route.scope === "read") {
        const names = [s.route.owner, ...s.route.collaborators];
        let text = "";
        for (const [i, name] of [...new Set(names)].entries()) {
          const output = await perform(
            name,
            `answer-${i}`,
            request + (text ? `\nConsultation so far:\n${text}` : ""),
          );
          text += `@${name}: ${output.text}\n`;
        }
        s.result = this.result(s, "completed", text.trim());
      } else {
        for (const capability of ["edit", "execute"] as const)
          new PermissionPolicy(o.grants).require(capability, [
            "edit",
            "execute",
          ]);
        if (!(await o.sandbox.available()))
          throw new Error(
            "Sandbox unavailable. Build the sandbox image or authorize cloud execution.",
          );
        if (!o.config.project.checks.length)
          throw new Error(
            "No check profile configured. Add required tests/build/static checks to .tfvn/config.yaml.",
          );
        if (!s.snapshot) {
          s.snapshot = await workspaces.snapshot(
            opts.snapshot ?? { tracked: "head", untracked: [] },
          );
          save();
          this.emit(sessionId, "snapshot", {
            id: s.snapshot.id,
            manifest: s.snapshot.manifest,
            base: s.snapshot.base,
          });
        }
        if (s.snapshot.manifest.excluded.length)
          throw new Error(
            `Snapshot excludes tracked files (${s.snapshot.manifest.excluded.join(", ")}); move secrets/submodules outside the coding snapshot before creating a deliverable branch`,
          );
        if (!s.baselineTests) {
          s.baselineTests = baselineTestPaths(
            s.snapshot.manifest.files,
            o.config.project.testPaths,
          );
          save();
        }
        if (!s.plan) {
          if (s.route.workflow === "small")
            s.plan = {
              criteria: [{ id: "AC1", text: request }],
              tasks: [
                {
                  id: "implementation",
                  department: ([
                    "dev",
                    "designer",
                    "docs",
                    "devops",
                    "test",
                  ].includes(dispatchResult.owner)
                    ? dispatchResult.owner
                    : "dev") as Plan["tasks"][number]["department"],
                  dependencies: [],
                  instructions: request,
                },
              ],
            };
          else {
            const planned = await structured(
              "plan",
              "planner",
              "plan",
              request,
              inspectRoot,
              `Return ONLY JSON matching ${JSON.stringify(z.toJSONSchema(planSchema))}. Tasks may run in parallel only with independent edits; express all dependencies. Acceptance criteria need stable unique IDs.`,
              (text) => {
                const plan = planSchema.parse(parseJson(text));
                validateGraph(plan.tasks);
                return plan;
              },
            );
            s.plan = planned.value;
          }
          save();
          this.emit(sessionId, "task.graph", s.plan);
        }
        if (s.route.workflow !== "small") {
          for (const dept of [
            "architect",
            ...(s.route.collaborators.includes("designer") ? ["designer"] : []),
          ])
            await perform(
              dept,
              `design-${dept}`,
              `${request}\nAcceptance criteria: ${JSON.stringify(s.plan.criteria)}`,
              inspectRoot,
              "Produce design contracts and handoff guidance; no code changes.",
            );
        }
        await ensureQa();
        for (; s.round < 3; s.round++) {
          await readSteering();
          const round = s.round;
          if (round === 0 && !s.workspace) {
            try {
              const ordered = validateGraph(s.plan.tasks);
              const commits = new Map<string, string>();
              await runGraph(
                ordered,
                o.config.limits.modifyingPerRepo,
                async (task) => {
                  const key = `impl-${task.id}`;
                  let ws = s.tasks[key]?.workspace;
                  if (!ws) {
                    let base = s.snapshot!.commit;
                    const ancestors = new Set<string>();
                    const add = (id: string) => {
                      for (const dep of ordered.find((t) => t.id === id)!
                        .dependencies) {
                        add(dep);
                        ancestors.add(dep);
                      }
                    };
                    add(task.id);
                    const deps = ordered
                      .filter((t) => ancestors.has(t.id))
                      .map((t) => commits.get(t.id)!)
                      .filter(Boolean);
                    if (deps.length) {
                      const integrated = await this.integrate(
                        workspaces,
                        s.snapshot!,
                        deps,
                        sessionId,
                      );
                      if (integrated.status === "conflict")
                        throw new IntegrationConflict(
                          integrated.conflicts,
                          integrated.workspace,
                          integrated.revision,
                        );
                      base = integrated.revision;
                    }
                    ws = await workspaces.create(s.snapshot!, task.id, base);
                    s.tasks[key] = { workspace: ws };
                    save();
                  }
                  if (!s.tasks[key]!.revision) {
                    await perform(
                      task.department,
                      key,
                      `${task.instructions}\nRequirements: ${JSON.stringify(s.plan!.criteria)}\nDesign: ${JSON.stringify(s.handoffs)}`,
                      ws.path,
                      "Implement the assigned task and relevant developer tests.",
                      false,
                    );
                    s.tasks[key]!.revision = await workspaces.commit(
                      ws,
                      `TFVN: ${task.id}`,
                    );
                    save();
                  }
                  const revision = s.tasks[key]!.revision!;
                  const parent = (
                    await git(ws.path, ["rev-parse", "HEAD^"])
                  ).trim();
                  // A task that made no commit must not cherry-pick its dependency snapshot.
                  if (
                    revision !== s.snapshot!.commit &&
                    (
                      await git(ws.path, ["log", "-1", "--format=%s"])
                    ).trim() === `TFVN: ${task.id}`
                  )
                    commits.set(task.id, revision);
                  return { revision, parent };
                },
              );
              const integrated = await this.integrate(
                workspaces,
                s.snapshot,
                [...commits.values()],
                sessionId,
              );
              s.workspace = integrated.workspace;
              s.revision = integrated.revision;
              save();
              if (integrated.status === "conflict")
                throw new IntegrationConflict(
                  integrated.conflicts,
                  integrated.workspace,
                  integrated.revision,
                );
            } catch (error) {
              if (!(error instanceof IntegrationConflict)) throw error;
              s.workspace = error.workspace;
              s.revision = error.revision;
              s.conflicts = error.conflicts;
              save();
              this.emit(sessionId, "repair.required", {
                round,
                blockers: [
                  `Integration conflict: ${error.conflicts.join(", ")}`,
                ],
              });
              if (round === 2)
                throw new Error(
                  `Repair limit reached. Human decision required: Integration conflict: ${error.conflicts.join(", ")}`,
                );
              continue;
            }
          } else if (round > 0) {
            if (round === 2)
              await perform(
                "architect",
                "escalation",
                `Two unsuccessful attempts. Revise the approach.\n${request}\nFailures: ${JSON.stringify({ checks: s.checks, reviews: s.reviews })}`,
                s.workspace!.path,
              );
            const owners = [
              ...new Set(s.plan!.tasks.map((task) => task.department)),
            ];
            for (const department of owners)
              await perform(
                department,
                `repair-${round}-${department}`,
                `Repair the blocking findings without deleting independent acceptance checks.\n${request}\n${JSON.stringify({ checks: s.checks, reviews: s.reviews, conflicts: s.conflicts ?? [], approach: s.handoffs.escalation })}`,
                s.workspace!.path,
                "",
                false,
              );
          }
          await perform(
            "test",
            `developer-tests-${round}`,
            `Inspect developer tests for ${request}. Add meaningful regression tests if missing and run the configured checks: ${JSON.stringify(o.config.project.checks)}.`,
            s.workspace!.path,
            "",
            false,
          );
          s.revision = await workspaces.commit(
            s.workspace!,
            `TFVN: candidate ${round + 1}`,
          );
          save();
          const changed = (
            await git(s.workspace!.path, [
              "diff",
              "--name-only",
              s.snapshot.base,
            ])
          )
            .trim()
            .split("\n")
            .filter(Boolean);
          if (
            changed.some((p) =>
              /auth|permission|migrat|schema|terraform|\.github\//i.test(p),
            )
          ) {
            if (s.route.workflow !== "sensitive") {
              s.route.workflow = "sensitive";
              s.route.risks.push("sensitive paths changed");
              this.emit(sessionId, "workflow.upgraded", {
                workflow: "sensitive",
                files: changed,
              });
              await perform(
                "architect",
                `risk-${round}`,
                `Assess contracts, migrations and rollback for this candidate. ${request}`,
                s.workspace!.path,
              );
            }
          } else if (changed.length > 10 && s.route.workflow === "small") {
            s.route.workflow = "feature";
            this.emit(sessionId, "workflow.upgraded", {
              workflow: "feature",
              files: changed,
            });
          }
          await ensureQa();
          const identity: EvidenceIdentity = {
            candidate: s.revision,
            base: s.snapshot.base,
            requirements: digest(s.plan.criteria),
            profile: digest({ checks: o.config.project.checks, qa: s.qaPlan }),
            environment: o.sandbox.identity,
            toolVersion: VERSION,
            baseline: digest(s.baselineTests ?? []),
          };
          s.checks = [];
          s.reviews = [];
          save();
          for (const check of o.config.project.checks) {
            await readSteering();
            this.emit(sessionId, "check.started", {
              name: check.name,
              command: check.command,
            });
            const scratch = await workspaces.create(
              s.snapshot!,
              `check-${check.name}-${round}`,
              s.revision,
            );
            let observed: ObservedCommand | undefined;
            try {
              observed = await this.runObserved(
                sessionId,
                scratch,
                check.name,
                check.command,
                signal,
                { timeoutMs: check.timeoutMs, readOnly: false },
              );
            } finally {
              await workspaces.discard(scratch);
            }
            const evidence = await o.artifacts.put(observed.log);
            s.artifacts.push(evidence);
            const record: CheckRun = {
              schemaVersion: 1,
              id: randomUUID(),
              identity,
              name: check.name,
              command: check.command,
              status: observed.status,
              exitCode: observed.exitCode,
              evidence: [evidence],
              ...(observed.status === "passed"
                ? {}
                : { logTail: logTail(observed.log) }),
            };
            s.checks.push(record);
            save();
            this.emit(sessionId, "check.completed", record);
          }
          const baselineRecord = await this.runBaseline(
            sessionId,
            workspaces,
            s.snapshot!,
            s.revision!,
            s.baselineTests ?? [],
            round,
            identity,
            signal,
          );
          s.checks.push(baselineRecord);
          s.artifacts.push(...baselineRecord.evidence);
          save();
          this.emit(sessionId, "check.completed", baselineRecord);
          await workspaces.assertClean(s.workspace!);
          if (s.qaPlan) {
            const qaWorkspace = await workspaces.create(
              s.snapshot,
              "acceptance",
              s.revision,
            );
            const directory = `.tfvn-qa/${s.id}`;
            await installAcceptance(
              qaWorkspace.path,
              directory,
              s.qaPlan.files,
            );
            let observed: ObservedCommand | undefined;
            try {
              if (!s.qaPlan.command?.length)
                throw new Error("unsupported acceptance runner");
              observed = await this.runObserved(
                sessionId,
                qaWorkspace,
                "independent-qa",
                s.qaPlan.command,
                signal,
                { readOnly: true, timeoutMs: 300000 },
              );
            } finally {
              await workspaces.discard(qaWorkspace);
            }
            const artifact = await o.artifacts.put(observed.log);
            s.artifacts.push(artifact);
            const check: CheckRun = {
              schemaVersion: 1,
              id: randomUUID(),
              identity,
              name: "independent-qa",
              command: s.qaPlan.command,
              status: observed.status,
              exitCode: observed.exitCode,
              evidence: [artifact],
              ...(observed.status === "passed"
                ? {}
                : { logTail: logTail(observed.log) }),
            };
            s.checks.push(check);
            save();
            this.emit(sessionId, "check.completed", check);
          }
          if (s.checks.every((c) => c.status === "passed")) {
            const assessors: ReviewVerdict["department"][] = ["review"];
            if (s.route.workflow !== "small") assessors.push("qa");
            if (s.route.workflow === "sensitive") assessors.push("security");
            for (const dept of assessors) {
              const assessmentId = `${dept}-${round}-${digest(identity).slice(0, 16)}`;
              let ws = s.tasks[assessmentId]?.workspace;
              if (!ws) {
                ws = await workspaces.create(
                  s.snapshot,
                  assessmentId,
                  s.revision,
                );
                s.tasks[assessmentId] = { workspace: ws };
                save();
              }
              const assessed = await structured(
                "assessment",
                dept,
                assessmentId,
                `Independently assess the final candidate ${s.revision} against base ${s.snapshot.base}.\nRequest: ${request}\nAcceptance criteria: ${JSON.stringify(s.plan.criteria)}\nMachine checks: ${JSON.stringify(s.checks)}\nCandidate diff:\n${(await workspaces.diff(s.workspace!)).slice(0, 80000)}`,
                ws.path,
                `ASSESSMENT CONTRACT: Return ONLY JSON matching ${JSON.stringify(z.toJSONSchema(assessmentSchema))}. Inspect actual repository files and tests; supplied implementation claims are not evidence. Approve only with adequate evidence. No product edits.`,
                (text) => assessmentSchema.parse(parseJson(text)),
              );
              const assessment = assessed.value;
              const verdict: ReviewVerdict = {
                schemaVersion: 1,
                id: randomUUID(),
                identity,
                department: dept,
                model: o.config.departments[dept]!.model.id,
                provider: o.config.departments[dept]!.model.provider,
                verdict: assessment.verdict,
                findings: assessment.findings,
                evidence: assessed.artifacts,
              };
              s.reviews.push(verdict);
              save();
              this.emit(sessionId, "review.completed", verdict);
            }
          }
          await workspaces.assertClean(s.workspace!);
          await readSteering();
          const gate = deliveryGate(
            identity,
            s.route.workflow,
            s.checks,
            s.reviews,
            o.config.project.checks.map((c) => c.name),
          );
          if (gate.ready) {
            s.result = this.result(
              s,
              "completed",
              `Ready for human review on ${s.workspace!.branch}. All configured checks passed and required Claude assessments approved this revision.`,
            );
            break;
          }
          this.emit(sessionId, "repair.required", {
            round: round + 1,
            blockers: gate.blockers,
          });
          s.round++;
          save();
          s.round--;
          if (round === 2)
            throw new Error(
              `Repair limit reached. Human decision required: ${gate.blockers.join("; ")}`,
            );
        }
      }
      await readSteering();
      if (!s.result) throw new Error("Workflow ended without a deliverable");
    } catch (e) {
      const cancelled = signal.aborted && signal.reason?.message !== "paused";
      s.result = this.result(
        s,
        s.pendingMessages?.length
          ? "paused"
          : cancelled
            ? "cancelled"
            : signal.aborted
              ? "paused"
              : "blocked",
        String(e instanceof Error ? e.message : e),
      );
    } finally {
      clearInterval(renew);
      j.release(`session:${sessionId}`, lockOwner);
    }
    save();
    j.setStatus(sessionId, s.result!.status);
    this.emit(sessionId, "run.completed", s.result);
    if (s.pendingMessages?.length && !opts.signal?.aborted)
      return this.execute(sessionId, "", { ...opts, resume: true });
    return s.result!;
  }
  private async runBaseline(
    sessionId: string,
    workspaces: WorkspaceService,
    snapshot: Snapshot,
    revision: string,
    files: { path: string; hash: string }[],
    round: number,
    identity: EvidenceIdentity,
    signal: AbortSignal,
  ): Promise<CheckRun> {
    const finish = (observed: ObservedCommand): Promise<CheckRun> =>
      this.options.artifacts.put(observed.log).then((evidence) => ({
        schemaVersion: 1 as const,
        id: randomUUID(),
        identity,
        name: "baseline-tests",
        command: ["baseline-tests"],
        status: observed.status,
        exitCode: observed.exitCode,
        evidence: [evidence],
        ...(observed.status === "passed"
          ? {}
          : { logTail: logTail(observed.log) }),
      }));
    if (!files.length)
      return finish({
        exitCode: 0,
        status: "passed",
        log: "No baseline test files",
      });
    const scratch = await workspaces.create(
      snapshot,
      `baseline-${round}`,
      revision,
    );
    try {
      for (const file of files) {
        const target = await safePath(scratch.path, file.path, {
          create: true,
        });
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          await git(this.options.repository, ["cat-file", "blob", file.hash]),
        );
      }
      await workspaces.commit(scratch, "TFVN: baseline tests");
      const logs: string[] = [];
      let status: CheckRun["status"] = "passed";
      let exitCode: number | null = 0;
      for (const check of this.options.config.project.checks) {
        const result = await this.runObserved(
          sessionId,
          scratch,
          `baseline-tests:${check.name}`,
          check.command,
          signal,
          { timeoutMs: check.timeoutMs, readOnly: false },
        );
        logs.push(`# ${check.name}\n${result.log}`);
        if (result.status !== "passed") {
          status = result.status;
          exitCode = result.exitCode;
          break;
        }
      }
      return await finish({ exitCode, status, log: logs.join("\n") });
    } finally {
      await workspaces.discard(scratch);
    }
  }
  private async runObserved(
    sessionId: string,
    workspace: Workspace,
    name: string,
    argv: string[],
    signal: AbortSignal,
    options: { timeoutMs?: number; readOnly: boolean },
  ): Promise<ObservedCommand> {
    let buffer = "";
    let last = Date.now();
    const flush = (force = false) => {
      if (!buffer) return;
      const now = Date.now();
      if (!force && now - last < 200) return;
      this.emit(sessionId, "command.output", { name, chunk: buffer });
      buffer = "";
      last = Date.now();
    };
    let exitCode: number | null = null;
    let status: CheckRun["status"] = "unavailable";
    let log = "";
    try {
      const output = await this.options.sandbox.run({
        workspace: workspace.path,
        argv,
        readOnly: options.readOnly,
        timeoutMs: options.timeoutMs,
        signal,
        onOutput: (chunk) => {
          buffer += chunk;
          flush();
        },
      });
      exitCode = output.exitCode;
      log = `${output.stdout}\n${output.stderr}`;
      const changed = (
        await git(workspace.path, ["diff", "--name-only", "HEAD"])
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      if (changed.length) {
        status = "failed";
        log += `\nCheck modified tracked source: ${changed.join(", ")}`;
      } else status = exitCode === 0 ? "passed" : "failed";
    } catch (e) {
      if (signal.aborted) throw e;
      log = String(e);
    } finally {
      flush(true);
    }
    return { exitCode, status, log };
  }
  private result(
    s: RunState,
    status: TaskResult["status"],
    summary: string,
  ): TaskResult {
    return {
      schemaVersion: 1,
      id: s.id,
      status,
      revision: s.revision,
      branch: s.workspace?.branch,
      workspace: s.workspace?.path,
      summary,
      artifacts: [...new Set(s.artifacts)],
      checks: s.checks,
      reviews: s.reviews,
      usage: s.usage,
      blockers: status === "completed" ? [] : [summary],
    };
  }
  private async integrate(
    service: WorkspaceService,
    snapshot: Snapshot,
    commits: string[],
    session: string,
  ) {
    const key = `integration:${this.options.repository}`,
      owner = randomUUID();
    if (!this.options.journal.acquire(key, owner, 300000))
      throw new Error("Another repository integration is running");
    try {
      this.emit(session, "integration.started", { commits });
      return await service.integrate(snapshot, commits);
    } finally {
      this.options.journal.release(key, owner);
    }
  }
  private async context(session: string): Promise<string> {
    const o = this.options,
      items: string[] = [];
    const prior = o.journal
      .events(session)
      .filter((e) =>
        ["message", "route", "run.completed", "steering"].includes(e.type),
      )
      .slice(-20);
    items.push(`Session history:\n${JSON.stringify(prior).slice(-24000)}`);
    for (const path of [
      ...o.config.project.instructions,
      ...o.config.project.skills,
    ])
      try {
        const full = await safePath(o.repository, path, {
          secretPaths: o.config.project.secretPaths,
        });
        const content = await readFile(full, "utf8");
        items.push(
          `Untrusted repository instructions from ${path}:\n${content.slice(0, 16000)}`,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    return items.join("\n");
  }
}
function balancedJson(text: string, start: number): string | undefined {
  const open = text[start];
  if (open !== "{" && open !== "[") return;
  const close = open === "{" ? "}" : "]";
  let depth = 0,
    quote = false,
    escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') quote = true;
    else if (
      ch === open ||
      (open === "{" && ch === "{") ||
      (open === "[" && ch === "[")
    )
      depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return;
}
function jsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const slice = balancedJson(text, i);
    if (!slice) continue;
    try {
      values.push(JSON.parse(slice));
      i += slice.length - 1;
    } catch {
      /* Keep scanning. A brace in prose is not a second document. */
    }
  }
  return values;
}
export function parseJson(text: string): unknown {
  const invalid = () => {
    throw new Error("Department did not return valid structured JSON");
  };
  const fences = [...text.matchAll(/```(?:json)?[^\n]*\n?([\s\S]*?)```/g)];
  if (fences.length > 1) invalid();
  if (fences.length === 1) {
    let value: unknown;
    try {
      value = JSON.parse(fences[0]![1]!.trim());
    } catch {
      invalid();
    }
    const match = fences[0]!;
    const outside =
      text.slice(0, match.index ?? 0) +
      text.slice((match.index ?? 0) + match[0].length);
    if (jsonValues(outside).length) invalid();
    return value;
  }
  const values = jsonValues(text);
  if (values.length !== 1) invalid();
  return values[0];
}
