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
import { runProcess } from "./process.js";
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
    description:
      "Read a UTF-8 repository file. Optional startLine and endLine are inclusive. Files larger than 256 KB return the first 400 lines unless a range is set.",
    schema: z
      .object({
        path: pathSchema,
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      })
      .strict(),
  },
  search: {
    capability: "read",
    sideEffect: false,
    description:
      "Search repository text. Literal by default; set regex true for a regular expression. Skips binaries, secrets, and ignored files.",
    schema: z
      .object({
        query: z.string().min(1).max(1000),
        regex: z.boolean().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      })
      .strict(),
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
      "Replace each hunk exactly once, in order. A missing or ambiguous hunk fails without writing. oldText/newText is a single hunk.",
    schema: z
      .object({
        path: pathSchema,
        oldText: z.string().min(1).optional(),
        newText: z.string().optional(),
        hunks: z
          .array(
            z
              .object({ oldText: z.string().min(1), newText: z.string() })
              .strict(),
          )
          .min(1)
          .max(20)
          .optional(),
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
/** Keep the start and the failing tail of a long observation. */
export function clipObservation(content: string, artifact: string): string {
  const bytes = Buffer.from(content);
  if (bytes.length <= 32000) return content;
  const omitted = bytes.length - 32000;
  const head = bytes.subarray(0, 8000).toString("utf8");
  const tail = bytes.subarray(bytes.length - 24000).toString("utf8");
  return `${head}\n[${omitted} bytes omitted; full artifact ${artifact}]\n${tail}`;
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
      return { content: clipObservation(content, artifact), artifact };
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
    if (name === "search")
      return this.search(
        args.query,
        args.regex === true,
        args.limit ?? 100,
        signal,
      );
    if (name === "read")
      return this.read(args.path, args.startLine, args.endLine);
    if (name === "write" || name === "patch") {
      const path = await this.resolve(args.path, name === "write");
      let content = args.content;
      if (name === "patch") {
        const hunks =
          args.hunks ??
          (typeof args.oldText === "string" && typeof args.newText === "string"
            ? [{ oldText: args.oldText, newText: args.newText }]
            : undefined);
        if (!hunks?.length)
          throw new ToolInputError("Patch needs oldText/newText or hunks");
        content = await this.readRaw(args.path);
        for (const hunk of hunks) {
          const located = locate(content, hunk.oldText);
          if (located.length !== 1)
            throw new ToolInputError(
              `Patch matched ${located.length} times in ${args.path}${
                located.length
                  ? `; first line ${located[0]}, last line ${located[located.length - 1]}`
                  : ""
              }`,
            );
          content = content.replace(hunk.oldText, hunk.newText);
        }
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
  private async search(
    query: string,
    regex: boolean,
    limit: number,
    signal?: AbortSignal,
  ) {
    if (regex)
      try {
        new RegExp(query);
      } catch (e) {
        throw new ToolInputError(
          `Invalid search pattern: ${e instanceof Error ? e.message : e}`,
        );
      }
    try {
      return await this.searchRg(query, regex, limit, signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return this.searchScan(query, regex, limit, signal);
      throw e;
    }
  }
  private async searchRg(
    query: string,
    regex: boolean,
    limit: number,
    signal?: AbortSignal,
  ) {
    const argv = [
      "rg",
      "--json",
      "--color",
      "never",
      "--glob",
      "!.git/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!dist/**",
      ...(regex ? [] : ["-F"]),
      "--",
      query,
      ".",
    ];
    let result;
    try {
      result = await runProcess(argv, {
        cwd: this.root,
        signal,
        timeoutMs: 30000,
        maxBytes: 8_000_000,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw e;
      throw new ToolInputError(String(e));
    }
    if (result.exitCode === 2)
      throw new ToolInputError(
        result.stderr.trim() || "Invalid search pattern",
      );
    const matches: { path: string; line: number; text: string }[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      let event: {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "match") continue;
      const path = event.data?.path?.text ?? "";
      if (!path || protectedPath(path, this.options.secretPaths)) continue;
      matches.push({
        path,
        line: event.data?.line_number ?? 0,
        text: (event.data?.lines?.text ?? "").replace(/\n$/, "").slice(0, 1000),
      });
      if (matches.length > limit) break;
    }
    return {
      matches: matches.slice(0, limit),
      truncated: matches.length > limit,
    };
  }
  private async searchScan(
    query: string,
    regex: boolean,
    limit: number,
    signal?: AbortSignal,
  ) {
    const pattern = regex ? new RegExp(query) : undefined;
    const matches: { path: string; line: number; text: string }[] = [];
    for (const path of await this.paths()) {
      signal?.throwIfAborted();
      let text: string;
      try {
        text = await this.readRaw(path);
      } catch {
        continue;
      }
      for (const [i, line] of text.split("\n").entries()) {
        if (pattern ? pattern.test(line) : line.includes(query)) {
          matches.push({ path, line: i + 1, text: line.slice(0, 1000) });
          if (matches.length > limit)
            return { matches: matches.slice(0, limit), truncated: true };
        }
      }
    }
    return { matches, truncated: false };
  }
  private async readRaw(path: string): Promise<string> {
    const bytes = await readFile(await this.resolve(path));
    if (bytes.length > 1_000_000)
      throw new ToolInputError(
        "File too large; use focused search or an artifact",
      );
    if (bytes.includes(0)) throw new ToolInputError("Binary file");
    return bytes.toString("utf8");
  }
  private async read(
    path: string,
    startLine?: number,
    endLine?: number,
  ): Promise<string> {
    const bytes = await readFile(await this.resolve(path));
    if (bytes.includes(0)) throw new ToolInputError("Binary file");
    const text = bytes.toString("utf8");
    const lines = text.split("\n");
    const total = lines.length;
    if (startLine || endLine) {
      const start = startLine ?? 1;
      const end = endLine ?? total;
      if (start > end)
        throw new ToolInputError(`startLine ${start} is after endLine ${end}`);
      if (start > total)
        throw new ToolInputError(
          `startLine ${start} is past the end (${total} lines)`,
        );
      const slice = lines.slice(start - 1, end);
      return `${slice.join("\n")}\n[${total} lines]`;
    }
    if (bytes.length > 256000) {
      const shown = Math.min(400, total);
      return `${lines.slice(0, shown).join("\n")}\n[Showing lines 1-${shown} of ${total}]`;
    }
    return text;
  }
}
function locate(content: string, needle: string): number[] {
  const lines: number[] = [];
  let from = 0;
  while (from <= content.length) {
    const at = content.indexOf(needle, from);
    if (at < 0) break;
    lines.push(content.slice(0, at).split("\n").length);
    from = at + Math.max(needle.length, 1);
  }
  return lines;
}
