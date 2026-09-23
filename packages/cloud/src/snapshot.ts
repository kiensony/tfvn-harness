import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { digest } from "../../core/src/artifacts.js";
import { protectedPath, safePath } from "../../core/src/paths.js";
import { type Snapshot } from "../../core/src/workspace.js";
export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    base: z.string().regex(/^[a-f0-9]{40,64}$/),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            content: z.string().max(16000000),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            mode: z.enum(["100644", "100755"]),
          })
          .strict(),
      )
      .max(50000),
  })
  .strict();
export type PortableSnapshot = z.infer<typeof snapshotSchema>;
export function validateSnapshot(value: unknown): PortableSnapshot {
  const snapshot = snapshotSchema.parse(value);
  let size = 0;
  const paths = new Set<string>();
  for (const f of snapshot.files) {
    if (
      protectedPath(f.path) ||
      f.path.includes("\\") ||
      f.path.includes("\0") ||
      isAbsolute(f.path) ||
      f.path.split("/").some((p) => p === ".." || p === "." || !p) ||
      paths.has(f.path)
    )
      throw new Error("Unsafe, duplicate or secret/protected snapshot path");
    paths.add(f.path);
    const bytes = Buffer.from(f.content, "base64");
    if (bytes.toString("base64") !== f.content || digest(bytes) !== f.sha256)
      throw new Error("Snapshot integrity failure");
    size += bytes.length;
    if (size > 32_000_000) throw new Error("Snapshot exceeds 32 MB limit");
  }
  return snapshot;
}
export async function exportSnapshot(
  repository: string,
  snapshot: Snapshot,
): Promise<PortableSnapshot> {
  const files: PortableSnapshot["files"] = [];
  for (const file of snapshot.manifest.files) {
    const { stdout } = await promisify(execFile)(
      "git",
      ["-C", repository, "cat-file", "blob", file.hash],
      { encoding: "buffer", maxBuffer: 16_000_000 },
    );
    files.push({
      path: file.path,
      mode: file.mode as "100644" | "100755",
      content: stdout.toString("base64"),
      sha256: digest(stdout),
    });
  }
  return validateSnapshot({ schemaVersion: 1, base: snapshot.base, files });
}
export async function materializeSnapshot(value: unknown, root: string) {
  const snapshot = validateSnapshot(value);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of snapshot.files) {
    const path = await safePath(root, file.path, { create: true });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(file.content, "base64"), {
      flag: "wx",
      mode: file.mode === "100755" ? 0o755 : 0o644,
    });
  }
  return snapshot;
}
