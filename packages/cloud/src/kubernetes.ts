import { randomUUID } from "node:crypto";
import { relative, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type Sandbox, type SandboxRequest } from "../../core/src/sandbox.js";
import { runProcess } from "../../core/src/process.js";
export function sandboxJob(
  request: SandboxRequest,
  config: { namespace: string; image: string; volume: string; root: string },
  name: string,
) {
  const subPath = relative(config.root, request.workspace);
  if (!subPath || subPath.startsWith("..") || isAbsolute(subPath))
    throw new Error("Workspace is outside sandbox volume");
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: config.namespace,
      labels: { "app.kubernetes.io/name": "tfvn-sandbox" },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: Math.ceil((request.timeoutMs ?? 2700000) / 1000),
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { "app.kubernetes.io/name": "tfvn-sandbox" } },
        spec: {
          runtimeClassName: "gvisor",
          nodeSelector: { "tfvn-role": "sandbox" },
          tolerations: [
            {
              key: "tfvn-role",
              operator: "Equal",
              value: "sandbox",
              effect: "NoSchedule",
            },
          ],
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          serviceAccountName: "tfvn-sandbox",
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "task",
              image: config.image,
              command: request.argv,
              workingDir: "/workspace",
              env: [
                { name: "HOME", value: "/tmp" },
                { name: "CI", value: "true" },
              ],
              resources: {
                requests: { cpu: "2", memory: "4Gi" },
                limits: { cpu: "2", memory: "4Gi" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              volumeMounts: [
                {
                  name: "workspace",
                  mountPath: "/workspace",
                  subPath,
                  readOnly: request.readOnly,
                },
                { name: "temp", mountPath: "/tmp" },
                {
                  name: "git-mask",
                  mountPath: "/workspace/.git",
                  subPath: "blocked",
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: "workspace",
              persistentVolumeClaim: { claimName: config.volume },
            },
            { name: "temp", emptyDir: { sizeLimit: "512Mi" } },
            {
              name: "git-mask",
              downwardAPI: {
                items: [
                  { path: "blocked", fieldRef: { fieldPath: "metadata.name" } },
                ],
              },
            },
          ],
        },
      },
    },
  };
}
export class KubernetesSandbox implements Sandbox {
  readonly identity: string;
  constructor(
    readonly config: {
      namespace: string;
      image: string;
      volume: string;
      root: string;
    },
  ) {
    if (!config.image.includes("@sha256:"))
      throw new Error("Cloud sandbox image must be digest-pinned");
    this.identity = `gvisor:${config.image}:network-none:v1`;
  }
  async available() {
    try {
      return (
        (
          await runProcess(
            [
              "kubectl",
              "auth",
              "can-i",
              "create",
              "jobs",
              "-n",
              this.config.namespace,
            ],
            { timeoutMs: 10000 },
          )
        ).exitCode === 0
      );
    } catch {
      return false;
    }
  }
  async run(request: SandboxRequest) {
    const name = `tfvn-${randomUUID()}`,
      namespace = this.config.namespace;
    request.signal?.throwIfAborted();
    try {
      const created = await runProcess(["kubectl", "create", "-f", "-"], {
        input: JSON.stringify(sandboxJob(request, this.config, name)),
        timeoutMs: 30000,
        signal: request.signal,
      });
      if (created.exitCode !== 0)
        throw new Error("Sandbox job creation failed");
      const deadline = Date.now() + (request.timeoutMs ?? 2700000);
      while (Date.now() < deadline) {
        request.signal?.throwIfAborted();
        const response = await runProcess(
          [
            "kubectl",
            "get",
            "pods",
            "-n",
            namespace,
            "-l",
            `job-name=${name}`,
            "-o",
            "json",
          ],
          { timeoutMs: 10000, signal: request.signal },
        );
        if (response.exitCode !== 0)
          throw new Error("Cannot inspect sandbox job");
        const pods = JSON.parse(response.stdout).items;
        const stopped =
          pods[0]?.status?.containerStatuses?.[0]?.state?.terminated;
        if (stopped) {
          const logs = await runProcess(
            ["kubectl", "logs", "-n", namespace, `job/${name}`],
            { timeoutMs: 10000, signal: request.signal },
          );
          return {
            exitCode: stopped.exitCode,
            stdout: logs.stdout,
            stderr: logs.stderr,
          };
        }
        await delay(1000, undefined, { signal: request.signal });
      }
      throw new Error("Sandbox job timed out");
    } finally {
      await runProcess(
        [
          "kubectl",
          "delete",
          "job",
          name,
          "-n",
          namespace,
          "--ignore-not-found",
          "--wait=true",
          "--timeout=10s",
        ],
        { timeoutMs: 15000 },
      ).catch(() => {});
    }
  }
}
