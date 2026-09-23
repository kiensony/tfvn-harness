import { randomUUID } from "node:crypto";
import { runProcess, type ProcessResult } from "./process.js";
export interface SandboxRequest {
  workspace: string;
  argv: string[];
  readOnly: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}
export interface Sandbox {
  identity: string;
  run(request: SandboxRequest): Promise<ProcessResult>;
  available(): Promise<boolean>;
}
export function dockerArgs(
  request: Omit<SandboxRequest, "signal" | "onOutput"> & {
    image: string;
    name: string;
  },
): string[] {
  if (request.workspace.includes(",") || request.workspace.includes("\n"))
    throw new Error("Unsupported workspace path");
  return [
    "run",
    "--rm",
    "--name",
    request.name,
    "--init",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--cpus=2",
    "--memory=4g",
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=512m",
    "--env",
    "HOME=/tmp",
    "--env",
    "CI=true",
    "--mount",
    `type=bind,source=${request.workspace},target=/workspace${request.readOnly ? ",readonly" : ""}`,
    "--mount",
    "type=bind,source=/dev/null,target=/workspace/.git,readonly",
    "--workdir",
    "/workspace",
    request.image,
    ...request.argv,
  ];
}
export class DockerSandbox implements Sandbox {
  private resolvedImage?: string;
  constructor(readonly image = "tfvn-sandbox:dev") {}
  get identity() {
    return `docker:${this.resolvedImage ?? this.image}:network-none:v1`;
  }
  async available() {
    if (this.resolvedImage) return true;
    try {
      const r = await runProcess(
        ["docker", "image", "inspect", this.image, "--format", "{{.Id}}"],
        { timeoutMs: 10000, maxBytes: 1000 },
      );
      const id = r.stdout.trim();
      if (r.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(id)) return false;
      this.resolvedImage = id;
      return true;
    } catch {
      return false;
    }
  }
  async run(request: SandboxRequest): Promise<ProcessResult> {
    if (!(await this.available()))
      throw new Error(
        "Sandbox unavailable. Build the configured image or authorize cloud execution.",
      );
    const name = `tfvn-${randomUUID()}`;
    try {
      return await runProcess(
        [
          "docker",
          ...dockerArgs({ ...request, image: this.resolvedImage!, name }),
        ],
        {
          signal: request.signal,
          timeoutMs: request.timeoutMs,
          onOutput: request.onOutput,
        },
      );
    } finally {
      await runProcess(["docker", "rm", "-f", name], {
        timeoutMs: 10000,
        maxBytes: 10000,
      }).catch(() => {});
    }
  }
}
