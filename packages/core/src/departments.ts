import {
  routeSchema,
  type DepartmentSpec,
  type RouteDecision,
} from "./contracts.js";
const roles: Record<
  string,
  [DepartmentSpec["model"]["provider"], string, string, DepartmentSpec["scope"]]
> = {
  assistant: [
    "qwen",
    "qwen3.8-27b",
    "Coordinate the requested scope and synthesize evidence. Never claim unrun checks passed.",
    "read",
  ],
  planner: [
    "openai",
    "gpt-6-astra",
    "Define testable acceptance criteria with IDs, dependencies and implementation tasks.",
    "read",
  ],
  architect: [
    "openai",
    "gpt-6-astra",
    "Define interfaces, architecture, migration and rollback contracts.",
    "read",
  ],
  designer: [
    "qwen",
    "qwen3.8-27b",
    "Design UI states, layout and accessibility. Implement only when explicitly requested.",
    "write",
  ],
  dev: [
    "qwen",
    "qwen3.8-27b",
    "Inspect and reproduce before implementing. Write relevant regression tests.",
    "write",
  ],
  test: [
    "qwen",
    "qwen3.8-27b",
    "Reproduce failures, write developer tests and execute checks.",
    "write",
  ],
  qa: [
    "anthropic",
    "claude-opus-5-5",
    "Independently evaluate acceptance criteria and edge cases. Report reproducible evidence. Do not edit product code.",
    "read",
  ],
  review: [
    "anthropic",
    "claude-opus-5-5",
    "Independently review the exact candidate for correctness and integration risk. Cite files and evidence.",
    "read",
  ],
  security: [
    "anthropic",
    "claude-opus-5-5",
    "Assess security-sensitive changes with reproducible source-to-sink evidence.",
    "read",
  ],
  devops: [
    "qwen",
    "qwen3.8-27b",
    "Validate build, CI and environment changes. Never merge or deploy production.",
    "write",
  ],
  docs: [
    "qwen",
    "qwen3.8-27b",
    "Write accurate documentation and validate examples.",
    "write",
  ],
  research: [
    "qwen",
    "qwen3.8-27b",
    "Inspect repository and approved technical sources; cite evidence.",
    "read",
  ],
};
export const departments: Record<string, DepartmentSpec> = Object.fromEntries(
  Object.entries(roles).map(([id, [provider, model, instructions, scope]]) => [
    id,
    {
      schemaVersion: 1,
      id,
      version: "1",
      model: {
        provider,
        id: model,
        effort:
          provider === "qwen"
            ? id === "assistant"
              ? "low"
              : "medium"
            : "high",
        contextTokens: provider === "qwen" ? 64000 : 128000,
      },
      instructions,
      scope,
      capabilities:
        scope === "write"
          ? ["read", "edit", "execute"]
          : [
              "read",
              ...(id === "research" ? ["network" as const] : []),
              ...(id === "qa" ? ["execute" as const] : []),
            ],
      tools:
        scope === "write"
          ? [
              "files",
              "read",
              "search",
              "write",
              "patch",
              "remove",
              "shell",
              "git_diff",
            ]
          : [
              "files",
              "read",
              "search",
              "git_diff",
              ...(id === "qa" ? ["shell"] : []),
              ...(id === "research" ? ["http_get"] : []),
            ],
      outputContract: provider === "anthropic" ? "Assessment" : "summary",
    } satisfies DepartmentSpec,
  ]),
);
export interface Dispatch {
  owner: string;
  departments: string[];
  command?: string;
  text: string;
  readonlyHint: boolean;
}
export const commands = [
  "plan",
  "build",
  "test",
  "review",
  "team",
  "tasks",
  "diff",
  "context",
  "model",
  "budget",
  "permissions",
  "pause",
  "resume",
  "cancel",
];
export function activeText(text: string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (match) {
        if (!fence) fence = match[1]!;
        else if (match[1]![0] === fence[0] && match[1]!.length >= fence.length)
          fence = undefined;
        return "";
      }
      if (fence || /^\s*>|^(?: {4}|\t)/.test(line)) return "";
      return line;
    })
    .join("\n")
    .replace(/(`+)[\s\S]*?\1/g, "")
    .replace(/"[^"\n]*"|(?<!\w)'[^'\n]*'(?!\w)|“[^”]*”|‘[^’]*’/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\\@/g, "");
}
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        next[j - 1]! + 1,
        row[j]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length]!;
}
export function dispatch(
  text: string,
  origin: "user" | "tool" | "repository" = "user",
  registry = departments,
): Dispatch {
  const active = origin === "user" ? activeText(text) : "";
  const names = [
    ...new Set(
      [
        ...active.matchAll(/(?:^|[\s,(])@([a-z][a-z0-9_-]*)\b(?![@.\w-])/gi),
      ].map((m) => m[1]!.toLowerCase()),
    ),
  ];
  for (const name of names)
    if (!registry[name]) {
      const suggestions = Object.keys(registry)
        .sort((a, b) => distance(name, a) - distance(name, b))
        .slice(0, 3);
      throw new Error(
        `Unknown department @${name}. Try ${suggestions.map((s) => "@" + s).join(", ")}`,
      );
    }
  const command = /^\s*\/(\w+)\b/.exec(active)?.[1];
  if (command && !commands.includes(command))
    throw new Error(`Unknown command /${command}`);
  const forced = command
    ? (
        {
          plan: "planner",
          build: "dev",
          test: "test",
          review: "review",
        } as Record<string, string>
      )[command]
    : undefined;
  const owner = forced ?? (names.length === 1 ? names[0]! : "assistant");
  const readonlyHint =
    ["qa", "review", "research", "planner", "architect", "security"].includes(
      owner,
    ) ||
    command === "plan" ||
    (/\b(propose|explain|describe|investigate|inspect|discuss|review|suggest|plan|design only)\b/i.test(
      active,
    ) &&
      !/\b(implement|build|fix|change|update|write|create|apply)\b/i.test(
        active,
      ));
  return { owner, departments: names, command, text, readonlyHint };
}
export function validateRoute(
  d: Dispatch,
  raw: unknown,
  registry = departments,
): RouteDecision {
  const route = routeSchema.parse(raw);
  if (route.owner !== d.owner)
    throw new Error(`Route owner must remain @${d.owner}`);
  for (const name of [route.owner, ...route.collaborators])
    if (!registry[name]) throw new Error(`Unknown department: ${name}`);
  if (
    (d.readonlyHint ||
      (registry[d.owner]?.scope === "read" && d.owner !== "assistant")) &&
    (route.scope !== "read" || route.workflow !== "readonly")
  )
    throw new Error("Requested scope is read-only");
  if ((route.scope === "read") !== (route.workflow === "readonly"))
    throw new Error("Scope and workflow disagree");
  if (
    route.risks.length &&
    route.scope === "write" &&
    route.workflow !== "sensitive"
  )
    throw new Error("Risk indicators require the sensitive workflow");
  for (const name of d.departments)
    if (name !== route.owner && !route.collaborators.includes(name))
      throw new Error(`Missing explicitly requested department ${name}`);
  return route;
}
