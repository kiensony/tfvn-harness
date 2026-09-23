import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { departments } from "./departments.js";
import {
  modelSchema,
  capabilitySchema,
  type DepartmentSpec,
  type Provider,
} from "./contracts.js";
const checkSchema = z
  .object({
    name: z.string().min(1),
    command: z.array(z.string()).min(1),
    timeoutMs: z.number().int().positive().max(2700000).default(300000),
  })
  .strict();
const customDepartmentSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    version: z.string().min(1),
    model: modelSchema,
    instructions: z.string().min(1),
    capabilities: z.array(capabilitySchema),
    tools: z.array(z.string()),
    scope: z.enum(["read", "write"]),
    outputContract: z.string().min(1),
  })
  .strict();
const projectSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    models: z.record(z.string(), z.string().min(1)).default({}),
    checks: z.array(checkSchema).default([]),
    secretPaths: z.array(z.string()).default([]),
    instructions: z.array(z.string()).default(["AGENTS.md"]),
    skills: z.array(z.string()).default([]),
    departments: z.array(customDepartmentSchema).default([]),
  })
  .strict();
const endpointSchema = z
  .object({
    baseUrl: z.url(),
    apiKeyEnv: z.string(),
    inputPerMillion: z.number().nonnegative().optional(),
    outputPerMillion: z.number().nonnegative().optional(),
    contextTokens: z.number().int().positive().optional(),
  })
  .strict();
const trustedSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    providers: z.record(z.string(), endpointSchema).default({}),
    allowedOrigins: z.array(z.url()).default([]),
    cloud: z
      .object({
        url: z.url(),
        tokenEnv: z.string().default("TFVN_CLOUD_TOKEN"),
      })
      .strict()
      .optional(),
    sandboxImage: z.string().default("tfvn-sandbox:dev"),
    limits: z
      .object({
        taskDollars: z.number().positive().default(50),
        sessionDollars: z.number().positive().default(500),
        dailyDollars: z.number().positive().default(1000),
        steps: z.number().int().positive().default(60),
        durationMs: z.number().positive().default(2700000),
        maxOutputTokens: z.number().int().positive().default(8192),
        workers: z.number().int().positive().max(32).default(32),
        implementationWorkers: z.number().int().positive().max(24).default(24),
        modifyingPerRepo: z.number().int().positive().max(4).default(4),
      })
      .default({
        taskDollars: 50,
        sessionDollars: 500,
        dailyDollars: 1000,
        steps: 60,
        durationMs: 2700000,
        maxOutputTokens: 8192,
        workers: 32,
        implementationWorkers: 24,
        modifyingPerRepo: 4,
      }),
  })
  .strict();
export type Endpoint = z.infer<typeof endpointSchema>;
export type CheckProfile = z.infer<typeof checkSchema>;
export interface Config extends z.infer<typeof trustedSchema> {
  project: z.infer<typeof projectSchema>;
  departments: Record<string, DepartmentSpec>;
}
export function loadConfig(input: {
  project?: unknown;
  trusted?: unknown;
}): Config {
  const project = projectSchema.parse(input.project ?? {}),
    trusted = trustedSchema.parse(input.trusted ?? {});
  const registry = structuredClone(departments);
  for (const profile of project.departments) {
    if (registry[profile.id])
      throw new Error("Custom department cannot shadow a built-in");
    if (
      profile.capabilities.includes("publish") ||
      profile.capabilities.includes("upload")
    )
      throw new Error("Departments cannot publish or upload directly");
    registry[profile.id] = { schemaVersion: 1, ...profile };
  }
  for (const [name, model] of Object.entries(project.models)) {
    if (!registry[name]) throw new Error(`Unknown department ${name}`);
    registry[name].model.id = model;
  }
  const providers: Record<string, Endpoint> = {
    qwen: {
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "DASHSCOPE_API_KEY",
    },
    openai: {
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    anthropic: {
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
    ...trusted.providers,
  };
  for (const [provider, ep] of Object.entries(providers)) {
    if (!["qwen", "openai", "anthropic"].includes(provider))
      throw new Error(`Unknown provider ${provider}`);
    if (new URL(ep.baseUrl).protocol !== "https:")
      throw new Error("Provider endpoints must use HTTPS");
    if (
      new URL(ep.baseUrl).username ||
      new URL(ep.baseUrl).password ||
      new URL(ep.baseUrl).search
    )
      throw new Error("Invalid provider URL");
  }
  for (const dept of Object.values(registry))
    if (providers[dept.model.provider]?.contextTokens)
      dept.model.contextTokens = Math.min(
        dept.model.contextTokens,
        providers[dept.model.provider]!.contextTokens!,
      );
  return { ...trusted, project, providers, departments: registry };
}
async function yamlFile(path: string): Promise<unknown> {
  try {
    return parse(await readFile(path, "utf8")) ?? {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}
export async function readConfig(
  repository: string,
  trustedPath = process.env.TFVN_CONFIG ??
    join(homedir(), ".config", "tfvn", "config.yaml"),
): Promise<Config> {
  return loadConfig({
    project: await yamlFile(join(repository, ".tfvn", "config.yaml")),
    trusted: await yamlFile(trustedPath),
  });
}
export function credentials(config: Config, provider: Provider): string {
  const ep = config.providers[provider];
  const key = ep && process.env[ep.apiKeyEnv];
  if (!key)
    throw new Error(`Missing ${ep?.apiKeyEnv ?? provider + " credentials"}`);
  return key;
}
