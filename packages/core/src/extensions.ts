import { z } from "zod";
import { type Capability } from "./contracts.js";
import { type ToolDefinition } from "./model.js";
import { type Sandbox } from "./sandbox.js";
export interface ExtensionSpec {
  name: string;
  description: string;
  schema: z.ZodType<Record<string, any>>;
  capability: Capability;
  sideEffect: boolean;
  location: "broker" | "sandbox";
  timeoutMs: number;
  maxOutputBytes: number;
  execute: (args: Record<string, any>, signal: AbortSignal) => Promise<string>;
}
const reserved = [
  "files",
  "read",
  "search",
  "write",
  "patch",
  "remove",
  "shell",
  "git_diff",
];
export class ExtensionRegistry {
  private tools = new Map<string, ExtensionSpec>();
  register(spec: ExtensionSpec) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(spec.name))
      throw new Error("Invalid tool name");
    if (reserved.includes(spec.name) || this.tools.has(spec.name))
      throw new Error("Tool name is reserved");
    if (
      spec.timeoutMs < 1 ||
      spec.timeoutMs > 2700000 ||
      spec.maxOutputBytes < 1 ||
      spec.maxOutputBytes > 8000000
    )
      throw new Error("Invalid tool limits");
    this.tools.set(spec.name, spec);
  }
  get(name: string) {
    return this.tools.get(name);
  }
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((s) => ({
      name: s.name,
      description: s.description,
      parameters: z.toJSONSchema(s.schema) as Record<string, unknown>,
    }));
  }
  async execute(
    name: string,
    args: unknown,
    parent: AbortSignal,
  ): Promise<string> {
    const spec = this.tools.get(name);
    if (!spec) throw new Error("Unknown extension");
    const input = spec.schema.parse(args),
      signal = AbortSignal.any([parent, AbortSignal.timeout(spec.timeoutMs)]);
    signal.throwIfAborted();
    let listener: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      listener = () => reject(signal.reason);
      signal.addEventListener("abort", listener, { once: true });
    });
    try {
      const result = await Promise.race([
        spec.execute(input, signal),
        cancelled,
      ]);
      if (Buffer.byteLength(result) > spec.maxOutputBytes)
        throw new Error("Extension output limit exceeded");
      return result;
    } finally {
      signal.removeEventListener("abort", listener);
    }
  }
}
export async function runHooks(
  commands: string[][],
  sandbox: Sandbox,
  workspace: string,
  signal: AbortSignal,
): Promise<string[]> {
  const evidence: string[] = [];
  for (const argv of commands) {
    const result = await sandbox.run({
      workspace,
      argv,
      readOnly: true,
      signal,
      timeoutMs: 300000,
    });
    evidence.push(JSON.stringify({ argv, ...result }));
    if (result.exitCode !== 0)
      throw new Error("Authorized hook failed; completion is blocked");
  }
  return evidence;
}
// MCP transport and tool schemas are supplied by trusted application code. Remote tool
// descriptions never become capability declarations. Each mapping goes through the broker.
export interface McpTransport {
  call(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
}
export function registerMcpTool(
  registry: ExtensionRegistry,
  transport: McpTransport,
  spec: Omit<ExtensionSpec, "execute">,
  remoteName: string,
) {
  registry.register({
    ...spec,
    execute: async (args, signal) =>
      JSON.stringify(
        await transport.call(
          "tools/call",
          { name: remoteName, arguments: args },
          signal,
        ),
      ),
  });
}
export function browserTestTool(
  registry: ExtensionRegistry,
  sandbox: Sandbox,
  workspace: string,
) {
  registry.register({
    name: "browser_test",
    description:
      "Execute the repository Playwright test suite in the offline sandbox.",
    schema: z
      .object({
        test: z
          .string()
          .regex(/^[a-zA-Z0-9_./-]+$/)
          .optional(),
      })
      .strict(),
    capability: "execute",
    sideEffect: true,
    location: "sandbox",
    timeoutMs: 300000,
    maxOutputBytes: 8000000,
    execute: async (args, signal) =>
      JSON.stringify(
        await sandbox.run({
          workspace,
          argv: [
            "npx",
            "--no-install",
            "playwright",
            "test",
            ...(args.test ? [args.test] : []),
          ],
          readOnly: false,
          signal,
          timeoutMs: 300000,
        }),
      ),
  });
}
