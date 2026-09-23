import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore } from "../packages/core/src/artifacts.js";
import { ToolBroker, PermissionPolicy } from "../packages/core/src/tools.js";
import { ExtensionRegistry } from "../packages/core/src/extensions.js";
import { z } from "zod";
test("registered extensions still pass through schema and permission checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "tfvn-extensions-"));
  const registry = new ExtensionRegistry();
  let calls = 0;
  registry.register({
    name: "lookup",
    description: "Lookup documentation",
    schema: z.object({ term: z.string().min(1) }).strict(),
    capability: "network",
    sideEffect: false,
    location: "broker",
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    execute: async (args) => {
      calls++;
      return `Found ${args.term}`;
    },
  });
  const broker = new ToolBroker(
    root,
    new PermissionPolicy(["read"]),
    new ArtifactStore(join(root, "artifacts")),
    undefined,
    {},
    registry,
  );
  await assert.rejects(
    broker.execute({ id: "x", name: "lookup", arguments: { term: "x" } }, [
      "network",
    ]),
    /Permission/,
  );
  assert.equal(calls, 0);
  const authorized = new ToolBroker(
    root,
    new PermissionPolicy(["network"]),
    broker.artifacts,
    undefined,
    {},
    registry,
  );
  assert.equal(
    (
      await authorized.execute(
        { id: "x", name: "lookup", arguments: { term: "x" } },
        ["network"],
      )
    ).content,
    "Found x",
  );
  await assert.rejects(
    authorized.execute(
      { id: "x", name: "lookup", arguments: { wrong: true } },
      ["network"],
    ),
  );
  assert.equal(calls, 1);
});
test("extensions cannot shadow builtins or exceed output and timeout limits", async () => {
  const registry = new ExtensionRegistry();
  const spec = {
    name: "read",
    description: "bad",
    schema: z.object({}),
    capability: "read" as const,
    sideEffect: false,
    location: "broker" as const,
    timeoutMs: 100,
    maxOutputBytes: 20,
    execute: async () => "",
  };
  assert.throws(() => registry.register(spec), /reserved/);
  registry.register({
    ...spec,
    name: "large",
    execute: async () => "x".repeat(21),
  });
  await assert.rejects(
    registry.execute("large", {}, new AbortController().signal),
    /output limit/,
  );
});

test("network broker blocks unapproved origins and special addresses", async () => {
  const { TrustedHttp, publicAddress } =
    await import("../packages/core/src/network.js");
  const http = new TrustedHttp(["https://docs.example.test"]);
  await assert.rejects(
    http.request("https://evil.test", new AbortController().signal),
    /authorized/,
  );
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress("8.8.8.8"), true);
});
