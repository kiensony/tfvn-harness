import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readlink,
  rm,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, dirname, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { digest } from "./artifacts.js";
import { runProcess } from "./process.js";
import { protectedPath, safePath } from "./paths.js";
const gitOptions = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "commit.gpgSign=false",
];
export async function git(
  root: string,
  argv: string[],
  options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  if (argv[0] === "diff")
    argv = ["diff", "--no-ext-diff", "--no-textconv", ...argv.slice(1)];
  const result = await runProcess(["git", ...gitOptions, "-C", root, ...argv], {
    input: options.input,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...options.env,
    },
    maxBytes: 32_000_000,
  });
  if (result.exitCode !== 0)
    throw new Error(`Git ${argv[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}
export interface SnapshotPolicy {
  tracked: "head" | "working";
  untracked: string[];
}
export interface Snapshot {
  schemaVersion: 1;
  id: string;
  base: string;
  commit: string;
  tree: string;
  manifest: {
    policy: SnapshotPolicy;
    files: { path: string; hash: string; mode: string }[];
    excluded: string[];
  };
}
export interface Workspace {
  path: string;
  branch: string;
  base: string;
}
export class WorkspaceService {
  constructor(
    readonly repository: string,
    readonly root: string,
    readonly secretPaths: string[] = [],
  ) {}
  async snapshot(policy: SnapshotPolicy): Promise<Snapshot> {
    const base = (
      await git(this.repository, ["rev-parse", "--verify", "HEAD"])
    ).trim();
    const temp = await mkdtemp(join(tmpdir(), "tfvn-index-"));
    const env = { GIT_INDEX_FILE: join(temp, "index") };
    try {
      await git(this.repository, ["read-tree", "--empty"], { env });
      const files: { path: string; hash: string; mode: string }[] = [],
        excluded: string[] = [];
      const head = (
        await git(this.repository, ["ls-tree", "-rz", "--full-tree", base])
      )
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const [meta, ...parts] = line.split("\t");
          const [mode, , hash] = meta!.split(" ");
          return { path: parts.join("\t"), hash: hash!, mode: mode! };
        });
      const entries = new Map(head.map((f) => [f.path, f]));
      if (policy.tracked === "working")
        for (const path of (
          await git(this.repository, ["ls-files", "-z", "--cached"])
        )
          .split("\0")
          .filter(Boolean))
          if (!entries.has(path))
            entries.set(path, { path, hash: "", mode: "100644" });
      for (const path of policy.untracked) {
        await safePath(this.repository, path, {
          secretPaths: this.secretPaths,
        });
        const ignored = await runProcess([
          "git",
          "-C",
          this.repository,
          "check-ignore",
          "--no-index",
          "--quiet",
          "--",
          path,
        ]);
        if (ignored.exitCode === 0)
          throw new Error(`Explicit path is ignored/excluded: ${path}`);
        if (ignored.exitCode !== 1)
          throw new Error("Cannot determine ignored paths");
        entries.set(path, { path, hash: "", mode: "100644" });
      }
      for (const entry of [...entries.values()].sort((a, b) =>
        a.path.localeCompare(b.path),
      )) {
        if (protectedPath(entry.path, this.secretPaths)) {
          excluded.push(entry.path);
          continue;
        }
        let { hash, mode } = entry;
        if (
          policy.tracked === "working" ||
          policy.untracked.includes(entry.path)
        ) {
          let stat;
          try {
            stat = await lstat(join(this.repository, entry.path));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw e;
          }
          if (stat.isSymbolicLink()) {
            excluded.push(entry.path);
            continue;
          }
          if (!stat.isFile()) {
            excluded.push(entry.path);
            continue;
          }
          const path = await safePath(this.repository, entry.path, {
            secretPaths: this.secretPaths,
          });
          hash = (
            await git(this.repository, ["hash-object", "-w", "--stdin"], {
              input: await readFile(path),
            })
          ).trim();
          mode = stat.mode & 0o111 ? "100755" : "100644";
        }
        if (!["100644", "100755"].includes(mode)) {
          excluded.push(entry.path);
          continue;
        }
        files.push({ path: entry.path, hash, mode });
      }
      if (files.length)
        await git(this.repository, ["update-index", "-z", "--index-info"], {
          env,
          input: files.map((f) => `${f.mode} ${f.hash}\t${f.path}\0`).join(""),
        });
      const tree = (await git(this.repository, ["write-tree"], { env })).trim();
      const manifest = { policy, files, excluded };
      const id = digest({ base, tree, manifest });
      const commit = (
        await git(this.repository, ["commit-tree", tree, "-p", base], {
          input: `TFVN source snapshot ${id}\n`,
          env: { ...env, ...author },
        })
      ).trim();
      await git(this.repository, [
        "update-ref",
        `refs/tfvn/snapshots/${id}`,
        commit,
      ]);
      return { schemaVersion: 1, id, base, commit, tree, manifest };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async create(
    snapshot: Snapshot,
    label: string,
    revision = snapshot.commit,
  ): Promise<Workspace> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const name = `${label.replace(/[^a-z0-9-]/gi, "-")}-${randomUUID().slice(0, 8)}`;
    const branch = `tfvn/${name}`,
      path = resolve(this.root, name);
    await git(this.repository, [
      "worktree",
      "add",
      "--no-checkout",
      "-b",
      branch,
      path,
      revision,
    ]);
    const entries = (
      await git(this.repository, ["ls-tree", "-rz", "--full-tree", revision])
    )
      .split("\0")
      .filter(Boolean);
    for (const entry of entries) {
      const tab = entry.indexOf("\t"),
        [mode, type, hash] = entry.slice(0, tab).split(" "),
        name = entry.slice(tab + 1);
      if (
        type !== "blob" ||
        !["100644", "100755"].includes(mode!) ||
        protectedPath(name, this.secretPaths)
      )
        throw new Error("Unsupported entry in task workspace");
      const target = await safePath(path, name, {
        create: true,
        secretPaths: this.secretPaths,
      });
      await mkdir(dirname(target), { recursive: true });
      const { stdout } = await promisify(execFile)(
        "git",
        [...gitOptions, "-C", this.repository, "cat-file", "blob", hash!],
        { encoding: "buffer", maxBuffer: 32_000_000 },
      );
      await writeFile(target, stdout, {
        mode: mode === "100755" ? 0o755 : 0o644,
      });
    }
    await git(path, ["reset", "--mixed", revision]);
    return { path, branch, base: snapshot.base };
  }
  async assertMetadata(workspace: Workspace) {
    const marker = join(workspace.path, ".git");
    const stat = await lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Invalid worktree metadata");
    const pointer = (await readFile(marker, "utf8")).trim();
    if (!pointer.startsWith("gitdir: "))
      throw new Error("Invalid worktree metadata");
    const common = await realpath(
      resolve(
        this.repository,
        (await git(this.repository, ["rev-parse", "--git-common-dir"])).trim(),
      ),
    );
    const directory = await realpath(resolve(workspace.path, pointer.slice(8)));
    const rel = relative(join(common, "worktrees"), directory);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/"))
      throw new Error(
        "Worktree metadata points outside its assigned repository",
      );
    const back = (await readFile(join(directory, "gitdir"), "utf8")).trim();
    if (resolve(back) !== resolve(marker))
      throw new Error("Worktree metadata belongs to another workspace");
  }
  async commit(workspace: Workspace, message: string): Promise<string> {
    await this.assertMetadata(workspace);
    // Build an index from file bytes. Never run clean filters or hooks on model output.
    const previous = (await git(workspace.path, ["rev-parse", "HEAD"])).trim();
    const next = await new WorkspaceService(
      workspace.path,
      this.root,
      this.secretPaths,
    ).snapshot({
      tracked: "working",
      untracked: (
        await git(workspace.path, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter(Boolean),
    });
    if (next.manifest.excluded.length)
      throw new Error("Refusing candidate with protected or unsupported files");
    if (
      next.tree !==
      (await git(workspace.path, ["rev-parse", "HEAD^{tree}"])).trim()
    ) {
      const commit = (
        await git(workspace.path, ["commit-tree", next.tree, "-p", previous], {
          input: message + "\n",
          env: author,
        })
      ).trim();
      await git(workspace.path, ["update-ref", "HEAD", commit, previous]);
      await git(workspace.path, ["reset", "--mixed", commit]);
      return commit;
    }
    return previous;
  }
  async integrate(
    snapshot: Snapshot,
    commits: string[],
  ): Promise<{
    status: "integrated" | "conflict";
    workspace: Workspace;
    revision: string;
    conflicts: string[];
  }> {
    const workspace = await this.create(snapshot, "integration");
    for (const commit of commits) {
      if (!/^[a-f0-9]{40,64}$/.test(commit))
        throw new Error("Invalid integration revision");
      try {
        await git(workspace.path, ["cherry-pick", commit], { env: author });
      } catch (e) {
        const conflicts = (
          await git(workspace.path, ["diff", "--name-only", "--diff-filter=U"])
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        if (conflicts.length)
          return {
            status: "conflict",
            workspace,
            revision: (await git(workspace.path, ["rev-parse", "HEAD"])).trim(),
            conflicts,
          };
        const message = e instanceof Error ? e.message : String(e);
        if (!/empty|conflict/i.test(message)) throw e;
        await git(workspace.path, ["cherry-pick", "--abort"]).catch(() => {});
        const changed = (
          await git(workspace.path, [
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            commit,
          ])
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        return {
          status: "conflict",
          workspace,
          revision: (await git(workspace.path, ["rev-parse", "HEAD"])).trim(),
          conflicts: changed.length ? changed : ["unknown"],
        };
      }
    }
    return {
      status: "integrated",
      workspace,
      revision: (await git(workspace.path, ["rev-parse", "HEAD"])).trim(),
      conflicts: [],
    };
  }
  async diff(workspace: Workspace): Promise<string> {
    await this.assertMetadata(workspace);
    return git(workspace.path, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      workspace.base,
    ]);
  }
  async discard(workspace: Workspace) {
    const removed = await runProcess(
      [
        "git",
        ...gitOptions,
        "-C",
        this.repository,
        "worktree",
        "remove",
        "--force",
        workspace.path,
      ],
      { timeoutMs: 30000, maxBytes: 1_000_000 },
    );
    if (removed.exitCode !== 0)
      await rm(workspace.path, { recursive: true, force: true }).catch(
        () => {},
      );
    await runProcess(
      ["git", ...gitOptions, "-C", this.repository, "worktree", "prune"],
      { timeoutMs: 30000, maxBytes: 1_000_000 },
    ).catch(() => {});
    await runProcess(
      [
        "git",
        ...gitOptions,
        "-C",
        this.repository,
        "branch",
        "-D",
        workspace.branch,
      ],
      { timeoutMs: 30000, maxBytes: 1_000_000 },
    ).catch(() => {});
  }
  async assertClean(workspace: Workspace) {
    await this.assertMetadata(workspace);
    if ((await git(workspace.path, ["status", "--porcelain=v1"])).trim())
      throw new Error(
        "Candidate changed after checkpoint; verification must be rerun",
      );
  }
}
const author = {
  GIT_AUTHOR_NAME: "TFVN Harness",
  GIT_AUTHOR_EMAIL: "tfvn@localhost",
  GIT_COMMITTER_NAME: "TFVN Harness",
  GIT_COMMITTER_EMAIL: "tfvn@localhost",
};
