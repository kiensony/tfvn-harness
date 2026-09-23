import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, WorkspaceService } from "../packages/core/src/workspace.js";
import { DockerSandbox } from "../packages/core/src/sandbox.js";
const enabled = process.env.RUN_DOCKER_TESTS === "1";
test(
  "real sandbox masks Git metadata, omits credentials and cleans up cancellation",
  { skip: !enabled },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tfvn-real-sandbox-"));
    await git(root, ["init", "-q"]);
    await writeFile(join(root, "index.js"), 'console.log("ok")');
    await git(root, ["add", "."]);
    await git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "base",
    ]);
    const service = new WorkspaceService(
        root,
        await mkdtemp(join(tmpdir(), "tfvn-real-worktree-")),
      ),
      snapshot = await service.snapshot({ tracked: "head", untracked: [] }),
      workspace = await service.create(snapshot, "sandbox");
    const marker = await readFile(join(workspace.path, ".git"), "utf8"),
      sandbox = new DockerSandbox();
    assert.equal(await sandbox.available(), true);
    assert.match(sandbox.identity, /^docker:sha256:[a-f0-9]{64}:/);
    const script = `const fs=require('fs'); if(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)process.exit(2); if(fs.readFileSync('.git','utf8')!=='')process.exit(3); try{fs.writeFileSync('.git','changed');}catch{} if(fs.readFileSync('.git','utf8')!=='')process.exit(4); fs.writeFileSync('replacement','tamper');try{fs.renameSync('replacement','.git');process.exit(5);}catch{} fs.writeFileSync('new.txt','safe');`;
    const result = await sandbox.run({
      workspace: workspace.path,
      argv: ["node", "-e", script],
      readOnly: false,
      timeoutMs: 30000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await readFile(join(workspace.path, ".git"), "utf8"), marker);
    assert.equal(
      await readFile(join(workspace.path, "new.txt"), "utf8"),
      "safe",
    );
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("cancelled")), 1000);
    try {
      await assert.rejects(
        sandbox.run({
          workspace: workspace.path,
          argv: ["node", "-e", "setTimeout(()=>{},60000)"],
          readOnly: false,
          signal: abort.signal,
        }),
        /cancel/,
      );
    } finally {
      clearTimeout(timer);
    }
  },
);
