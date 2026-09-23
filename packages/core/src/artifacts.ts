import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
export function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
}
export class ArtifactStore {
  constructor(readonly root: string) {}
  async put(content: string | Buffer): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const id = digest(content);
    const temp = join(this.root, `.${randomUUID()}`);
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    try {
      await rename(temp, join(this.root, id));
    } finally {
      await unlink(temp).catch(() => {});
    }
    return id;
  }
  async get(id: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid artifact ID");
    const value = await readFile(join(this.root, id));
    if (digest(value) !== id) throw new Error("Artifact integrity failure");
    return value;
  }
}
