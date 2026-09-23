import { type SessionEvent } from "../../core/src/contracts.js";
export function terminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
export function describe(event: SessionEvent): string | undefined {
  const p = event.payload as any;
  if (event.type === "route")
    return `@${p.owner} · ${p.workflow} · ${p.outcome}`;
  if (event.type === "handoff") return `→ @${p.department} (${p.taskId})`;
  if (event.type === "tool.started") return `  @${p.department} · ${p.name}`;
  if (event.type === "check.started") return `  Running ${p.name}`;
  if (event.type === "check.completed") return `  ${p.name}: ${p.status}`;
  if (event.type === "review.completed")
    return `  @${p.department}: ${p.verdict}`;
  if (event.type === "run.completed")
    return `${p.status}: ${p.summary}${p.workspace ? "\nWorkspace: " + p.workspace : ""}${p.revision ? "\nRevision: " + p.revision : ""}`;
  if (event.type === "workflow.upgraded")
    return `Workflow expanded to ${p.workflow}`;
  if (event.type === "repair.required")
    return `Repair ${p.round}: ${p.blockers.join("; ")}`;
  if (event.type === "snapshot")
    return `Snapshot ${p.id.slice(0, 12)} · ${p.manifest.files.length} files · ${p.manifest.policy.tracked}`;
  return undefined;
}
export function outputEvent(event: SessionEvent, json: boolean) {
  if (json) process.stdout.write(JSON.stringify(event) + "\n");
  else {
    const line = describe(event);
    if (line) process.stdout.write(terminalText(line) + "\n");
  }
}
export function oneEvent(type: string, payload: unknown): SessionEvent {
  return {
    schemaVersion: 1,
    sessionId: "cli",
    sequence: 1,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}
