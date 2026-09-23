import { Storage } from "@google-cloud/storage";
import { ArtifactStore, digest } from "../../core/src/artifacts.js";
export class GcsArtifactStore extends ArtifactStore {
  private readonly storage = new Storage();
  constructor(readonly bucket: string) {
    super(`gs://${bucket}`);
  }
  override async put(content: string | Buffer): Promise<string> {
    const id = digest(content);
    try {
      await this.storage
        .bucket(this.bucket)
        .file(id)
        .save(content, {
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { contentType: "application/octet-stream" },
        });
    } catch (e) {
      if ((e as { code?: number }).code !== 412) throw e;
    }
    return id;
  }
  override async get(id: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid artifact ID");
    const [data] = await this.storage.bucket(this.bucket).file(id).download();
    if (digest(data) !== id) throw new Error("Artifact integrity failure");
    return data;
  }
}
export function artifactStore(root: string): ArtifactStore {
  return process.env.TFVN_ARTIFACT_BUCKET
    ? new GcsArtifactStore(process.env.TFVN_ARTIFACT_BUCKET)
    : new ArtifactStore(root);
}
