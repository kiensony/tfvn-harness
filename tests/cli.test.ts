import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProcess } from "../packages/core/src/process.js";
const cli = resolve("packages/cli/src/main.ts");
async function invoke(args: string[]) {
  return runProcess([process.execPath, "--import", "tsx", cli, ...args], {
    timeoutMs: 30000,
  });
}
test("CLI emits valid versioned JSON and can resume a persisted offline session", async () => {
  const state = await mkdtemp(join(tmpdir(), "tfvn-cli-"));
  const run = await invoke([
    "run",
    "Explain the project",
    "--mock",
    "--json",
    "--state",
    state,
  ]);
  assert.equal(run.exitCode, 0, run.stderr);
  const events = run.stdout
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.ok(events.length > 2);
  assert.ok(events.every((e) => e.schemaVersion === 1));
  const session = events[0].sessionId;
  const status = await invoke(["status", session, "--json", "--state", state]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).payload.session.status, "completed");
  const resumed = await invoke([
    "resume",
    session,
    "--mock",
    "--json",
    "--state",
    state,
  ]);
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  assert.match(resumed.stdout, /Offline mock/);
});
test("departments lists all configured profiles and doctor labels untested access", async () => {
  const depts = await invoke(["departments", "--json"]);
  const value = JSON.parse(depts.stdout);
  assert.equal(value.payload.departments.length, 12);
  const doctor = await invoke(["doctor", "--json"]);
  const checks = JSON.parse(doctor.stdout).payload.checks;
  assert.ok(
    checks.some((c: any) => c.name === "qwen" && c.liveTested === false),
  );
});
test("unknown CLI options fail with diagnostics, not a successful empty session", async () => {
  const result = await invoke(["run", "hello", "--made-up"]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Unknown|unknown/);
});
test("read-only design requests work in a non-Git directory without command grants", async () => {
  const state = await mkdtemp(join(tmpdir(), "tfvn-cli-design-"));
  const repo = await mkdtemp(join(tmpdir(), "tfvn-cli-files-"));
  const run = await invoke([
    "run",
    "@designer propose a layout",
    "--mock",
    "--json",
    "--state",
    state,
    "--repo",
    repo,
  ]);
  assert.equal(run.exitCode, 0, run.stdout + run.stderr);
  const events = run.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    events.find((e) => e.type === "route").payload.owner,
    "designer",
  );
  assert.equal(events.at(-1).payload.status, "completed");
});
