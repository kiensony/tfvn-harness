import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  rename,
  unlink,
  lstat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Capability } from "./contracts.js";
import { type ToolCall, type ToolDefinition } from "./model.js";
import { ArtifactStore } from "./artifacts.js";
import { safePath, protectedPath } from "./paths.js";
import { git } from "./workspace.js";
import { type Sandbox } from "./sandbox.js";
import { ExtensionRegistry } from "./extensions.js";
export class ToolInputError extends Error {}
export class PermissionPolicy {
  constructor(
    readonly grants: Capability[],
    readonly denied: Capability[] = [],
  ) {}
  require(capability: Capability, role: Capability[]) {
    if (
      this.denied.includes(capability) ||
      !this.grants.includes(capability) ||
      !role.includes(capability)
    )
      throw new ToolInputError(`Permission denied: ${capability}`);
  }
}
const pathSchema = z.string().min(1).max(4096);
const definitions = {
  files: {
    capability: "read",
    sideEffect: false,
    description: "List repository files, excluding secrets and ignored files.",
    schema: z.object({}).strict(),
  },
  read: {
    capability: "read",
    sideEffect: false,
    description: "Read a UTF-8 repository file.",
    schema: z.object({ path: pathSchema }).strict(),
  },
  search: {
    capability: "read",
    sideEffect: false,
    description: "Search repository text with a literal string.",
    schema: z.object({ query: z.string().min(1).max(1000) }).strict(),
  },
  write: {
    capability: "edit",
    sideEffect: true,
    description: "Create or replace a UTF-8 file in the task workspace.",
    schema: z
      .object({ path: pathSchema, content: z.string().max(1000000) })
      .strict(),
  },
  patch: {
    capability: "edit",
    sideEffect: true,
    description:
      "Replace exactly one literal occurrence. Fails for missing or ambiguous matches.",
    schema: z
      .object({
        path: pathSchema,
        oldText: z.string().min(1),
        newText: z.string(),
      })
      .strict(),
  },
  remove: {
    capability: "edit",
    sideEffect: true,
    description: "Delete one file in the task workspace.",
    schema: z.object({ path: pathSchema }).strict(),
  },
  shell: {
    capability: "execute",
    sideEffect: true,
    description:
      "Run an argument vector inside the isolated container. No network or credentials.",
    schema: z
      .object({
        argv: z.array(z.string().max(32000)).min(1).max(128),
        timeoutMs: z.number().int().positive().max(2700000).optional(),
      })
      .strict(),
  },
  git_diff: {
    capability: "read",
    sideEffect: false,
    description: "Inspect current changes.",
    schema: z.object({}).strict(),
  },
} as const;
export interface ToolResult {
  content: string;
  artifact: string;
  error?: boolean;
}
export class ToolBroker {
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    readonly policy: PermissionPolicy,
    readonly artifacts: ArtifactStore,
    readonly sandbox?: Sandbox,
    readonly options: {
      secretPaths?: string[];
      readOnly?: boolean;
      onCommand?: (data: unknown) => void;
    } = {},
    readonly extensions = new ExtensionRegistry(),
  ) {}
  definitions(capabilities: Capability[], names?: string[]): ToolDefinition[] {
    const builtins = Object.entries(definitions)
      .filter(
        ([name, d]) =>
          capabilities.includes(d.capability) &&
          this.policy.grants.includes(d.capability) &&
          !this.policy.denied.includes(d.capability) &&
          (!names || names.includes(name)),
      )
      .map(([name, d]) => ({
        name,
        description: d.description,
        parameters: z.toJSONSchema(d.schema) as Record<string, unknown>,
      }));
    return [
      ...builtins,
      ...this.extensions.definitions().filter((t) => {
        const spec = this.extensions.get(t.name)!;
        return (
          (!names || names.includes(t.name)) &&
          capabilities.includes(spec.capability) &&
          this.policy.grants.includes(spec.capability) &&
          !this.policy.denied.includes(spec.capability)
        );
      }),
    ];
  }
  isMutation(name: string): boolean {
    return (
      definitions[name as keyof typeof definitions]?.sideEffect ??
      this.extensions.get(name)?.sideEffect ??
      true
    );
  }
  async execute(
    call: ToolCall,
    capabilities: Capability[],
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const def =
      definitions[call.name as keyof typeof definitions] ??
      this.extensions.get(call.name);
    if (!def) throw new ToolInputError(`Unknown tool ${call.name}`);
    this.policy.require(def.capability, capabilities);
    let args: Record<string, any>;
    try {
      args = def.schema.parse(call.arguments) as Record<string, any>;
    } catch (e) {
      throw new ToolInputError(String(e));
    }
    if (this.options.readOnly && def.capability === "edit")
      throw new ToolInputError("Permission denied: read-only workspace");
    const work = async () => {
      signal?.throwIfAborted();
      const value = this.extensions.get(call.name)
        ? await this.extensions.execute(
            call.name,
            args,
            signal ?? new AbortController().signal,
          )
        : await this.invoke(call.name, args, signal);
      const content = typeof value === "string" ? value : JSON.stringify(value);
      const artifact = await this.artifacts.put(content);
      return {
        content:
          content.length > 32000
            ? content.slice(0, 32000) +
              `\n[Truncated; full artifact ${artifact}]`
            : content,
        artifact,
      };
    };
    if (!def.sideEffect) return work();
    const pending = this.mutation.then(work, work);
    this.mutation = pending.catch(() => {});
    return pending;
  }
  private async paths(): Promise<string[]> {
    try {
      return (
        await git(this.root, [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter((p) => p && !protectedPath(p, this.options.secretPaths));
    } catch {
      const files: string[] = [];
      const walk = async (dir: string) => {
        for (const e of await readdir(join(this.root, dir), {
          withFileTypes: true,
        })) {
          const p = dir ? `${dir}/${e.name}` : e.name;
          if (
            protectedPath(p, this.options.secretPaths) ||
            ["node_modules", "dist"].includes(e.name) ||
            e.isSymbolicLink()
          )
            continue;
          if (e.isDirectory()) await walk(p);
          else if (e.isFile()) files.push(p);
          if (files.length >= 10000) return;
        }
      };
      await walk("");
      return files;
    }
  }
  private async invoke(
    name: string,
    args: Record<string, any>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (name === "files") return this.paths();
    if (name === "search") {
      const found: unknown[] = [];
      for (const path of await this.paths()) {
        signal?.throwIfAborted();
        try {
          const text = await this.read(path);
          for (const [i, line] of text.split("\n").entries())
            if (line.includes(args.query)) {
              found.push({ path, line: i + 1, text: line.slice(0, 1000) });
              if (found.length >= 100) return found;
            }
        } catch {}
      }
      return found;
    }
    if (name === "read") return this.read(args.path);
    if (name === "write" || name === "patch") {
      const path = await this.resolve(args.path, name === "write");
      let content = args.content;
      if (name === "patch") {
        const original = await this.read(args.path);
        if (original.split(args.oldText).length !== 2)
          throw new ToolInputError("Patch must match exactly once");
        content = original.replace(args.oldText, args.newText);
      }
      await mkdir(dirname(path), { recursive: true });
      const mode = await lstat(path).then(
        (s) => s.mode & 0o777,
        (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return 0o644;
          throw e;
        },
      );
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, content, { mode, flag: "wx" });
      await rename(temp, path);
      return `Updated ${args.path}`;
    }
    if (name === "remove") {
      await unlink(await this.resolve(args.path));
      return `Removed ${args.path}`;
    }
    if (name === "git_diff")
      return git(this.root, ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]);
    if (name === "shell") {
      if (!this.sandbox)
        throw new ToolInputError(
          "Sandbox unavailable; host command execution is prohibited",
        );
      this.options.onCommand?.({ argv: args.argv });
      return this.sandbox.run({
        workspace: this.root,
        argv: args.argv,
        readOnly: this.options.readOnly ?? false,
        signal,
        timeoutMs: args.timeoutMs,
      });
    }
    throw new Error("Unknown tool");
  }
  private async resolve(path: string, create = false) {
    try {
      return await safePath(this.root, path, {
        create,
        secretPaths: this.options.secretPaths,
      });
    } catch (e) {
      throw new ToolInputError(String(e));
    }
  }
  private async read(path: string): Promise<string> {
    const bytes = await readFile(await this.resolve(path));
    if (bytes.length > 256000)
      throw new ToolInputError(
        "File too large; use focused search or an artifact",
      );
    if (bytes.includes(0)) throw new ToolInputError("Binary file");
    return bytes.toString("utf8");
  }
}
