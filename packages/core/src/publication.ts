import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, WorkspaceService } from "./workspace.js";
import { Journal } from "./journal.js";
import { digest } from "./artifacts.js";
import { type TaskResult } from "./contracts.js";
import { runProcess } from "./process.js";
export async function publishDraft(
  repository: string,
  result: TaskResult,
  journal: Journal,
): Promise<string> {
  if (
    result.status !== "completed" ||
    !result.revision ||
    !result.branch ||
    !result.workspace ||
    !result.reviews.length ||
    !result.checks.length
  )
    throw new Error("Only a verified code candidate can be published");
  if (
    !result.checks.every(
      (c) => c.identity.candidate === result.revision && c.status === "passed",
    ) ||
    !result.reviews.every(
      (r) =>
        r.identity.candidate === result.revision && r.verdict === "approved",
    )
  )
    throw new Error("Publication evidence is stale");
  await new WorkspaceService(repository, "unused").assertClean({
    path: result.workspace,
    branch: result.branch,
    base: result.checks[0]!.identity.base,
  });
  const head = (await git(result.workspace, ["rev-parse", "HEAD"])).trim();
  if (head !== result.revision) throw new Error("Candidate HEAD changed");
  const remote = (
    await git(repository, ["remote", "get-url", "origin"])
  ).trim();
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
      remote,
    );
  if (!match) throw new Error("Publication requires a GitHub origin");
  const repo = match[1]!,
    baseBranch = (await git(repository, ["branch", "--show-current"])).trim();
  if (!baseBranch)
    throw new Error("Select an intended base branch before publication");
  const base = result.checks[0]!.identity.base;
  const remoteBase = (
    await git(repository, ["ls-remote", remote, `refs/heads/${baseBranch}`])
  ).split(/\s/)[0];
  if (remoteBase !== base)
    throw new Error(
      "Remote base changed; integrate and reverify before publication",
    );
  const operation = `publish:${repo}:${result.branch}`;
  const op = journal.beginOperation(
    operation,
    digest({ repo, branch: result.branch, head, base }),
  );
  const remoteHead = (
    await git(repository, ["ls-remote", remote, `refs/heads/${result.branch}`])
  ).split(/\s/)[0];
  if (remoteHead && remoteHead !== head)
    throw new Error(
      "Published branch differs from the evaluated revision; do not overwrite",
    );
  if (!remoteHead) {
    if (op === "done")
      throw new Error("Previously published branch no longer exists");
    await git(result.workspace, [
      "push",
      remote,
      `${head}:refs/heads/${result.branch}`,
    ]);
  }
  const verified = (
    await git(repository, [
      "ls-remote",
      remote,
      `refs/heads/${result.branch}`,
      `refs/heads/${baseBranch}`,
    ])
  )
    .trim()
    .split("\n");
  if (
    !verified.includes(`${head}\trefs/heads/${result.branch}`) ||
    !verified.includes(`${base}\trefs/heads/${baseBranch}`)
  )
    throw new Error("Published head/base mismatch; verification must be rerun");
  const existing = await runProcess([
    "gh",
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    result.branch,
    "--state",
    "all",
    "--json",
    "url,headRefOid,baseRefName",
  ]);
  if (existing.exitCode !== 0)
    throw new Error("Cannot reconcile existing GitHub PRs");
  const prs = JSON.parse(existing.stdout) as {
    url: string;
    headRefOid: string;
    baseRefName: string;
  }[];
  const prior = prs.find(
    (p) => p.headRefOid === head && p.baseRefName === baseBranch,
  );
  if (prior) {
    journal.finishOperation(operation, { url: prior.url });
    return prior.url;
  }
  if (prs.length)
    throw new Error("A PR already exists with a different candidate/base");
  const temp = await mkdtemp(join(tmpdir(), "tfvn-pr-"));
  try {
    const body = join(temp, "body.md");
    await writeFile(
      body,
      `${result.summary}\n\nCandidate: \`${head}\`\nBase: \`${base}\`\n\nChecks:\n${result.checks.map((c) => `- ${c.name}: ${c.status} (${c.evidence.join(", ")})`).join("\n")}\n\nReviews:\n${result.reviews.map((r) => `- @${r.department}: ${r.verdict} (${r.model})`).join("\n")}\n\nMerging and production release require human approval.\n`,
    );
    const created = await runProcess([
      "gh",
      "pr",
      "create",
      "--repo",
      repo,
      "--head",
      result.branch,
      "--base",
      baseBranch,
      "--draft",
      "--title",
      "TFVN: tested candidate",
      "--body-file",
      body,
    ]);
    if (created.exitCode !== 0)
      throw new Error(
        "PR creation failed or is uncertain; resume to reconcile the existing branch and PR",
      );
    const url = created.stdout.trim();
    journal.finishOperation(operation, { url });
    return url;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
