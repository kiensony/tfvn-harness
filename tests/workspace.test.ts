import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  chmod,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { WorkspaceService, git } from "../packages/core/src/workspace.js";
import { ToolBroker, PermissionPolicy } from "../packages/core/src/tools.js";
import { ArtifactStore } from "../packages/core/src/artifacts.js";
import { dockerArgs } from "../packages/core/src/sandbox.js";
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "tfvn-repo-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@example.test",
  ]);
  await writeFile(join(root, ".gitignore"), ".env\nignored\n");
  await writeFile(join(root, "a.txt"), "base\n");
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  return root;
}
test("snapshots preserve staged and unstaged content without touching the user index", async () => {
  const root = await repo();
  await writeFile(join(root, "a.txt"), "staged\n");
  await git(root, ["add", "a.txt"]);
  await writeFile(join(root, "a.txt"), "unstaged\n");
  await writeFile(join(root, "new.txt"), "selected\n");
  await writeFile(join(root, "other.txt"), "not selected\n");
  await writeFile(join(root, ".env"), "SECRET");
  const before = await git(root, ["status", "--porcelain=v1"]);
  const staged = await git(root, ["diff", "--cached"]);
  const service = new WorkspaceService(
    root,
    await mkdtemp(join(tmpdir(), "tfvn-ws-")),
  );
  const snapshot = await service.snapshot({
    tracked: "working",
    untracked: ["new.txt"],
  });
  const task = await service.create(snapshot, "dev");
  assert.equal(await readFile(join(task.path, "a.txt"), "utf8"), "unstaged\n");
  assert.equal(
    await readFile(join(task.path, "new.txt"), "utf8"),
    "selected\n",
  );
  await assert.rejects(readFile(join(task.path, "other.txt")));
  await assert.rejects(readFile(join(task.path, ".env")));
  assert.equal(await git(root, ["status", "--porcelain=v1"]), before);
  assert.equal(await git(root, ["diff", "--cached"]), staged);
  assert.ok(snapshot.manifest.files.every((f) => f.path !== ".env"));
  await assert.rejects(
    service.snapshot({ tracked: "working", untracked: [".env"] }),
    /excluded|secret|ignored/,
  );
});
test("independent task commits integrate and same-file conflicts are surfaced", async () => {
  const root = await repo(),
    service = new WorkspaceService(
      root,
      await mkdtemp(join(tmpdir(), "tfvn-ws-")),
    );
  const snapshot = await service.snapshot({ tracked: "head", untracked: [] });
  const one = await service.create(snapshot, "one"),
    two = await service.create(snapshot, "two");
  await writeFile(join(one.path, "a.txt"), "one\n");
  await writeFile(join(two.path, "a.txt"), "two\n");
  const c1 = await service.commit(one, "one"),
    c2 = await service.commit(two, "two");
  const conflict = await service.integrate(snapshot, [c1, c2]);
  assert.equal(conflict.status, "conflict");
  assert.ok(conflict.conflicts.includes("a.txt"));
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "base\n");
});
test("broker rejects path escapes, symlinks, secret files and unsupported capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "tfvn-tools-"));
  await writeFile(join(root, "safe"), "ok");
  await writeFile(join(root, ".env"), "secret");
  await symlink("/etc", join(root, "outside"));
  const broker = new ToolBroker(
    root,
    new PermissionPolicy(["read", "edit"]),
    new ArtifactStore(join(root, "artifacts")),
  );
  assert.match(
    (
      await broker.execute(
        { id: "1", name: "read", arguments: { path: "safe" } },
        ["read"],
      )
    ).content,
    /ok/,
  );
  for (const path of [
    "../secret",
    "/etc/passwd",
    ".env",
    "outside/passwd",
    ".git/config",
  ])
    await assert.rejects(
      broker.execute({ id: "2", name: "read", arguments: { path } }, ["read"]),
      /path|secret|protected|symlink/i,
    );
  await assert.rejects(
    broker.execute(
      { id: "3", name: "write", arguments: { path: "safe", content: "bad" } },
      ["read"],
    ),
    /permission/i,
  );
  await broker.execute(
    {
      id: "4",
      name: "patch",
      arguments: { path: "safe", oldText: "ok", newText: "fixed" },
    },
    ["read", "edit"],
  );
  assert.equal(await readFile(join(root, "safe"), "utf8"), "fixed");
  await assert.rejects(
    broker.execute(
      {
        id: "5",
        name: "patch",
        arguments: { path: "safe", oldText: "ok", newText: "bad" },
      },
      ["read", "edit"],
    ),
    /match/,
  );
});
test("container commands carry no host secrets, host mounts or network authority", () => {
  const args = dockerArgs({
    workspace: "/task",
    argv: ["node", "--test"],
    readOnly: true,
    image: "tfvn-sandbox:dev",
    name: "test-task",
  });
  assert.ok(args.includes("--network=none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(
    args.some((a) => a.includes("source=/task,target=/workspace,readonly")),
  );
  assert.ok(
    !args.some((a) => a.includes("docker.sock") || a.includes("API_KEY")),
  );
});
test("file edits preserve executable modes so edited CLI scripts remain runnable", async () => {
  const root = await mkdtemp(join(tmpdir(), "tfvn-mode-"));
  await writeFile(join(root, "run.sh"), "#!/bin/sh\necho old\n");
  await chmod(join(root, "run.sh"), 0o755);
  const broker = new ToolBroker(
    root,
    new PermissionPolicy(["read", "edit"]),
    new ArtifactStore(join(root, "artifacts")),
  );
  await broker.execute(
    {
      id: "patch",
      name: "patch",
      arguments: { path: "run.sh", oldText: "old", newText: "new" },
    },
    ["read", "edit"],
  );
  assert.equal((await stat(join(root, "run.sh"))).mode & 0o777, 0o755);
  await broker.execute(
    {
      id: "write",
      name: "write",
      arguments: { path: "run.sh", content: "#!/bin/sh\necho replaced\n" },
    },
    ["read", "edit"],
  );
  assert.equal((await stat(join(root, "run.sh"))).mode & 0o777, 0o755);
});
test("host Git operations reject altered task metadata before touching the source index", async () => {
  const root = await repo(),
    service = new WorkspaceService(
      root,
      await mkdtemp(join(tmpdir(), "tfvn-ws-")),
    );
  const snapshot = await service.snapshot({ tracked: "head", untracked: [] }),
    task = await service.create(snapshot, "tamper");
  const before = await git(root, ["status", "--porcelain=v1"]);
  await writeFile(join(task.path, ".git"), `gitdir: ${join(root, ".git")}\n`);
  await writeFile(join(task.path, "a.txt"), "changed");
  await assert.rejects(service.commit(task, "unsafe"), /metadata|worktree/i);
  assert.equal(await git(root, ["status", "--porcelain=v1"]), before);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "base\n");
});
