import type { CloudRun } from "./contracts.js";

// Select a fair admission window from durable state. Claim order cannot let one
// owner consume slots reserved for other queued owners or exceed repository caps.
type AdmissionRun = Pick<
  CloudRun,
  "id" | "owner" | "status" | "leaseUntil" | "createdAt"
> & { submission: Pick<CloudRun["submission"], "mode" | "repositoryKey"> };
export function chooseAdmissions(
  runs: AdmissionRun[],
  now: number,
): Set<string> {
  const active = runs.filter(
    (r) => r.status === "running" && r.leaseUntil > now,
  );
  const waiting = runs.filter(
    (r) =>
      r.status === "queued" || (r.status === "running" && r.leaseUntil <= now),
  );
  const selected = new Set<string>();
  const load = (r: AdmissionRun, repository = false) =>
    active.filter(
      (a) =>
        a.owner === r.owner &&
        (!repository ||
          a.submission.repositoryKey === r.submission.repositoryKey),
    ).length;
  while (active.length < 32) {
    const eligible = waiting.filter(
      (r) =>
        !selected.has(r.id) &&
        (r.submission.mode !== "write" ||
          (active.filter((a) => a.submission.mode === "write").length < 24 &&
            active.filter(
              (a) =>
                a.owner === r.owner &&
                a.submission.repositoryKey === r.submission.repositoryKey &&
                a.submission.mode === "write",
            ).length < 4)),
    );
    eligible.sort(
      (a, b) =>
        load(a) - load(b) ||
        load(a, true) - load(b, true) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
    const next = eligible[0];
    if (!next) break;
    selected.add(next.id);
    active.push(next);
  }
  return selected;
}

export interface QueuedTask {
  id: string;
  owner: string;
  repository: string;
  kind: "implementation" | "assessment" | "integration";
}
export class FairScheduler {
  private queued: QueuedTask[] = [];
  private active = new Map<string, QueuedTask>();
  private lastOwner = "";
  enqueue(task: QueuedTask) {
    if (this.active.has(task.id) || this.queued.some((t) => t.id === task.id))
      throw new Error("Duplicate task");
    this.queued.push(task);
  }
  admit(): QueuedTask[] {
    const admitted: QueuedTask[] = [];
    while (this.active.size < 32) {
      const owners = [...new Set(this.queued.map((t) => t.owner))];
      const previous = owners.indexOf(this.lastOwner);
      const order = [
        ...owners.slice(previous + 1),
        ...owners.slice(0, previous + 1),
      ];
      let selected: QueuedTask | undefined;
      for (const owner of order) {
        selected = this.queued.find(
          (t) => t.owner === owner && this.eligible(t),
        );
        if (selected) break;
      }
      if (!selected) break;
      this.lastOwner = selected.owner;
      this.active.set(selected.id, selected);
      this.queued = this.queued.filter((t) => t.id !== selected!.id);
      admitted.push(selected);
    }
    return admitted;
  }
  release(id: string) {
    this.active.delete(id);
  }
  cancel(id: string) {
    this.active.delete(id);
    this.queued = this.queued.filter((t) => t.id !== id);
  }
  private eligible(task: QueuedTask) {
    const active = [...this.active.values()];
    if (
      task.kind === "implementation" &&
      (active.filter((t) => t.kind === "implementation").length >= 24 ||
        active.filter(
          (t) =>
            t.repository === task.repository &&
            t.owner === task.owner &&
            t.kind === "implementation",
        ).length >= 4)
    )
      return false;
    if (
      task.kind === "integration" &&
      active.some(
        (t) =>
          t.kind === "integration" &&
          t.owner === task.owner &&
          t.repository === task.repository,
      )
    )
      return false;
    return true;
  }
}
