import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
export function protectedPath(path: string, extra: string[] = []): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  return (
    parts.some(
      (p) =>
        [".git", ".ssh", ".aws", ".gnupg", ".superpowers"].includes(
          p.toLowerCase(),
        ) ||
        /^\.env(?:\.|$)/i.test(p) ||
        /\.(pem|key|p12|pfx)$/i.test(p) ||
        /^(credentials|id_rsa|id_ed25519)$/i.test(p),
    ) ||
    path.startsWith(".tfvn/state") ||
    extra.some((p) => path === p || path.startsWith(p.replace(/\/$/, "") + "/"))
  );
}
export async function safePath(
  root: string,
  path: string,
  options: { create?: boolean; secretPaths?: string[] } = {},
): Promise<string> {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.split("/").includes("..") ||
    protectedPath(path, options.secretPaths)
  )
    throw new Error("Unsafe or secret/protected path");
  const canonical = await realpath(root),
    target = resolve(canonical, path),
    rel = relative(canonical, target);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("Path escapes workspace");
  let current = canonical;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const s = await lstat(current);
      if (s.isSymbolicLink()) throw new Error("Symlink paths are not allowed");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && options.create)
        continue;
      throw e;
    }
  }
  return target;
}
