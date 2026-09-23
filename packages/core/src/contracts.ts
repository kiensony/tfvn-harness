import { z } from "zod";

export const VERSION = "0.1.0-dev.1";
export const providerSchema = z.enum(["qwen", "openai", "anthropic", "mock"]);
export type Provider = z.infer<typeof providerSchema>;
export const capabilitySchema = z.enum([
  "read",
  "edit",
  "execute",
  "network",
  "upload",
  "publish",
]);
export type Capability = z.infer<typeof capabilitySchema>;
export const workflowSchema = z.enum([
  "readonly",
  "small",
  "feature",
  "sensitive",
]);
export type Workflow = z.infer<typeof workflowSchema>;
export const modelSchema = z
  .object({
    provider: providerSchema,
    id: z.string().min(1),
    effort: z.enum(["low", "medium", "high"]),
    contextTokens: z.number().int().positive(),
  })
  .strict();
export type ModelSpec = z.infer<typeof modelSchema>;
export interface DepartmentSpec {
  schemaVersion: 1;
  id: string;
  version: string;
  model: ModelSpec;
  instructions: string;
  capabilities: Capability[];
  tools: string[];
  scope: "read" | "write";
  outputContract: string;
}
export const routeSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z.string().min(1),
    collaborators: z.array(z.string()),
    workflow: workflowSchema,
    outcome: z.string().min(1),
    scope: z.enum(["read", "write"]),
    risks: z.array(z.string()),
    placement: z.enum(["local", "cloud"]),
    clarifications: z.array(z.string()),
    artifacts: z.array(z.string()),
  })
  .strict();
export type RouteDecision = z.infer<typeof routeSchema>;
export interface Budget {
  dollars: number;
  steps: number;
  durationMs: number;
  maxOutputTokens: number;
}
export interface TaskSpec {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  department: string;
  request: string;
  dependencies: string[];
  snapshot: string;
  requirements: string;
  permissions: Capability[];
  budget: Budget;
  placement: "local" | "cloud";
  generation: number;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  requestId?: string;
  estimated?: boolean;
}
export interface EvidenceIdentity {
  candidate: string;
  base: string;
  requirements: string;
  profile: string;
  environment: string;
  toolVersion: string;
}
export interface CheckRun {
  schemaVersion: 1;
  id: string;
  identity: EvidenceIdentity;
  name: string;
  status: "passed" | "failed" | "unavailable";
  command: string[];
  exitCode: number | null;
  evidence: string[];
}
export const findingSchema = z
  .object({
    id: z.string(),
    severity: z.enum(["critical", "high", "medium", "low"]),
    blocking: z.boolean(),
    description: z.string().min(1),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    evidence: z.array(z.string()).min(1),
  })
  .strict();
export const assessmentSchema = z
  .object({
    verdict: z.enum(["approved", "changes_requested", "blocked"]),
    findings: z.array(findingSchema),
    summary: z.string().min(1),
  })
  .strict();
export type Assessment = z.infer<typeof assessmentSchema>;
export interface ReviewVerdict {
  schemaVersion: 1;
  id: string;
  identity: EvidenceIdentity;
  department: "qa" | "review" | "security";
  model: string;
  provider: Provider;
  verdict: Assessment["verdict"];
  findings: Assessment["findings"];
  evidence: string[];
}
export interface Approval {
  schemaVersion: 1;
  id: string;
  actor: string;
  actionDigest: string;
  scope: string;
  expiresAt: string;
  createdAt: string;
}
export type TaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled"
  | "failed";
export interface TaskResult {
  schemaVersion: 1;
  id: string;
  status: TaskStatus;
  revision?: string;
  branch?: string;
  workspace?: string;
  summary: string;
  artifacts: string[];
  checks: CheckRun[];
  reviews: ReviewVerdict[];
  usage: Usage;
  blockers: string[];
}
export interface SessionEvent {
  schemaVersion: 1;
  sessionId: string;
  taskId?: string;
  sequence: number;
  type: string;
  timestamp: string;
  payload: unknown;
}
export interface Session {
  schemaVersion: 1;
  id: string;
  repository: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}
export function sameIdentity(
  a: EvidenceIdentity,
  b: EvidenceIdentity,
): boolean {
  return (
    (Object.keys(a) as (keyof EvidenceIdentity)[]).every(
      (k) => a[k] === b[k],
    ) &&
    (Object.keys(b) as (keyof EvidenceIdentity)[]).every((k) => a[k] === b[k])
  );
}
export function deliveryGate(
  identity: EvidenceIdentity,
  workflow: Workflow,
  checks: CheckRun[],
  reviews: ReviewVerdict[],
  requiredChecks?: string[],
) {
  const blockers: string[] = [];
  if (workflow === "readonly") return { ready: true, blockers };
  if (
    (workflow === "feature" || workflow === "sensitive") &&
    !checks.some((c) => c.name === "independent-qa")
  )
    blockers.push("Missing independent executable acceptance checks");
  if (!checks.length) blockers.push("No machine-generated checks completed");
  for (const name of requiredChecks ?? [])
    if (!checks.some((c) => c.name === name))
      blockers.push(`Missing check: ${name}`);
  for (const c of checks) {
    if (!sameIdentity(identity, c.identity))
      blockers.push(`Stale check: ${c.name}`);
    if (c.status !== "passed" || c.exitCode !== 0 || !c.evidence.length)
      blockers.push(`Check did not pass: ${c.name}`);
  }
  const required = [
    "review",
    ...(workflow === "feature" || workflow === "sensitive" ? ["qa"] : []),
    ...(workflow === "sensitive" ? ["security"] : []),
  ];
  for (const dept of required) {
    const current = reviews.filter(
      (r) => r.department === dept && sameIdentity(identity, r.identity),
    );
    if (!current.length) blockers.push(`Missing current ${dept}`);
    for (const r of current)
      if (
        r.provider !== "anthropic" ||
        r.verdict !== "approved" ||
        !r.evidence.length ||
        r.findings.some((f) => f.blocking)
      )
        blockers.push(`${dept} has not approved the candidate`);
  }
  return { ready: blockers.length === 0, blockers };
}
