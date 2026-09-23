import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatch,
  validateRoute,
  departments,
} from "../packages/core/src/departments.js";
import { Journal } from "../packages/core/src/journal.js";
import { ArtifactStore } from "../packages/core/src/artifacts.js";
import { loadConfig } from "../packages/core/src/config.js";
import {
  deliveryGate,
  type EvidenceIdentity,
} from "../packages/core/src/contracts.js";

test("every unmentioned user message returns to assistant", () => {
  assert.equal(dispatch("@designer propose a layout").owner, "designer");
  assert.equal(dispatch("make the header smaller").owner, "assistant");
  assert.deepEqual(dispatch("@dev consult @architect").departments, [
    "dev",
    "architect",
  ]);
  assert.equal(dispatch("@dev consult @architect").owner, "assistant");
});
const ignored = [
  "`@dev`",
  "```ts\n@dev fix it\n```",
  "~~~\n@dev\n~~~",
  "> @dev fix this",
  "Email jane@dev.example",
  'The file says "@dev fix"',
  "They wrote '@qa inspect'",
  "Use “@qa” in documentation",
  "\\@dev",
  "    @dev example",
  "[ref](https://x.test/@dev)",
  "```\n@dev unclosed",
  "Contact @dev@example.org",
];
for (const message of ignored)
  test(`mentions are inert in ${JSON.stringify(message)}`, () => {
    assert.equal(dispatch(message).owner, "assistant");
  });
test("tool and repository content never dispatch", () => {
  assert.equal(dispatch("@dev", "tool").owner, "assistant");
  assert.equal(dispatch("@dev", "repository").owner, "assistant");
});
test("unknown names suggest registry entries", () => {
  assert.throws(() => dispatch("@desginer improve layout"), /designer/);
  assert.equal(departments.review!.model.provider, "anthropic");
});
test("explicit scope and mandatory workflows constrain model route decisions", () => {
  const base = {
    schemaVersion: 1,
    owner: "assistant",
    collaborators: ["dev"],
    workflow: "small",
    outcome: "layout",
    scope: "write",
    risks: [],
    placement: "local",
    clarifications: [],
    artifacts: [],
  };
  assert.throws(
    () => validateRoute(dispatch("@designer propose a layout"), base),
    /scope|owner/,
  );
  assert.throws(
    () =>
      validateRoute(dispatch("@qa check this branch"), {
        ...base,
        owner: "qa",
      }),
    /scope/,
  );
  assert.throws(
    () =>
      validateRoute(dispatch("upgrade authentication"), {
        ...base,
        risks: ["authentication"],
      }),
    /sensitive/,
  );
});
test("project settings cannot redirect providers or increase authority", () => {
  assert.throws(
    () =>
      loadConfig({
        project: { providers: { qwen: { baseUrl: "https://evil.test" } } },
      }),
    /provider|Unrecognized/i,
  );
  assert.throws(
    () => loadConfig({ project: { permissions: ["publish"] } }),
    /Unrecognized/,
  );
  assert.equal(loadConfig({}).limits.workers, 32);
  assert.equal(
    loadConfig({ project: { models: { dev: "my-model" } } }).departments.dev!
      .model.id,
    "my-model",
  );
});
test("SQLite survives reopen with monotonically sequenced events and operation fencing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tfvn-journal-"));
  let journal = new Journal(join(dir, "journal.sqlite"));
  const session = journal.createSession("/repo");
  journal.append(session.id, "message", { text: "hello" });
  journal.saveCheckpoint(session.id, "dev", { step: 2 });
  assert.equal(journal.beginOperation("op1", "digest"), "new");
  journal.close();
  journal = new Journal(join(dir, "journal.sqlite"));
  assert.deepEqual(journal.checkpoint(session.id, "dev"), { step: 2 });
  assert.equal(journal.beginOperation("op1", "digest"), "uncertain");
  assert.throws(() => journal.beginOperation("op1", "other"), /digest/);
  journal.finishOperation("op1", { result: 42 });
  assert.deepEqual(journal.operationResult("op1"), { result: 42 });
  journal.append(session.id, "message", { text: "again" });
  assert.deepEqual(
    journal.events(session.id, 1).map((e) => e.sequence),
    [2],
  );
  journal.close();
});
test("artifact IDs are content addresses and do not permit traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tfvn-artifact-"));
  const store = new ArtifactStore(dir);
  const a = await store.put("test output");
  assert.equal(await store.put("test output"), a);
  assert.equal((await store.get(a)).toString(), "test output");
  await assert.rejects(store.get("../secret"), /artifact/i);
  assert.equal((await readFile(join(dir, a))).toString(), "test output");
});
test("delivery fails closed for missing, stale, and failed evidence", () => {
  const identity: EvidenceIdentity = {
    candidate: "a".repeat(40),
    base: "b".repeat(40),
    requirements: "req1",
    profile: "checks1",
    environment: "node24",
    toolVersion: "1",
  };
  const check = {
    schemaVersion: 1 as const,
    id: "check",
    identity,
    name: "test",
    status: "passed" as const,
    command: ["node", "--test"],
    exitCode: 0,
    evidence: ["log"],
  };
  const review = {
    schemaVersion: 1 as const,
    id: "review",
    identity,
    department: "review" as const,
    model: "claude-opus-5-5",
    provider: "anthropic" as const,
    verdict: "approved" as const,
    findings: [],
    evidence: ["log"],
  };
  assert.equal(deliveryGate(identity, "small", [check], [review]).ready, true);
  assert.equal(
    deliveryGate(identity, "feature", [check], [review]).ready,
    false,
  );
  assert.equal(deliveryGate(identity, "small", [], [review]).ready, false);
  assert.equal(
    deliveryGate(
      identity,
      "small",
      [{ ...check, status: "failed", exitCode: 1 }],
      [review],
    ).ready,
    false,
  );
  assert.equal(
    deliveryGate(
      { ...identity, candidate: "c".repeat(40) },
      "small",
      [check],
      [review],
    ).ready,
    false,
  );
  assert.equal(
    deliveryGate(identity, "small", [check], [{ ...review, provider: "qwen" }])
      .ready,
    false,
  );
});
