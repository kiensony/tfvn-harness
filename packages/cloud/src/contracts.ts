import { z } from "zod";
import { snapshotSchema } from "./snapshot.js";
import {
  type Capability,
  type SessionEvent,
  type TaskResult,
  type Approval,
} from "../../core/src/contracts.js";
export const submissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    request: z.string().min(1).max(100000),
    repositoryKey: z.string().min(1).max(200),
    mode: z.enum(["read", "write"]),
    snapshot: snapshotSchema,
  })
  .strict();
export type Submission = z.infer<typeof submissionSchema>;
export interface Principal {
  id: string;
  capabilities: readonly Capability[];
}
export interface CloudRun {
  id: string;
  owner: string;
  key: string;
  digest: string;
  submission: Submission;
  status:
    "queued" | "running" | "completed" | "blocked" | "cancelled" | "failed";
  generation: number;
  leaseUntil: number;
  result?: TaskResult;
  createdAt: string;
}
export interface CloudStore {
  create(
    owner: string,
    key: string,
    digest: string,
    submission: Submission,
  ): Promise<CloudRun>;
  get(owner: string, id: string): Promise<CloudRun | undefined>;
  internalGet(id: string): Promise<CloudRun | undefined>;
  append(
    id: string,
    type: string,
    payload: unknown,
    generation?: number,
  ): Promise<SessionEvent | undefined>;
  events(owner: string, id: string, after: number): Promise<SessionEvent[]>;
  claim(id: string, now: number, ttl: number): Promise<CloudRun | undefined>;
  heartbeat(
    id: string,
    generation: number,
    now: number,
    ttl: number,
  ): Promise<boolean>;
  finish(
    id: string,
    generation: number,
    result: TaskResult,
    now: number,
    steeringSequence?: number,
  ): Promise<boolean>;
  cancel(owner: string, id: string): Promise<void>;
  approve(owner: string, key: string, approval: Approval): Promise<Approval>;
}
export interface Dispatcher {
  start(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
}
