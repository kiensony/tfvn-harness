import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { type Dispatcher } from "./contracts.js";
export class TemporalDispatcher implements Dispatcher {
  constructor(
    readonly client: Client,
    readonly taskQueue = "tfvn-runs",
  ) {}
  async start(id: string) {
    try {
      await this.client.workflow.start("executeRun", {
        workflowId: `tfvn-${id}`,
        taskQueue: this.taskQueue,
        args: [id],
      });
    } catch (e) {
      if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
    }
  }
  async cancel(id: string) {
    try {
      await this.client.workflow.getHandle(`tfvn-${id}`).cancel();
    } catch (e) {
      if (!(e instanceof WorkflowNotFoundError)) throw e;
    }
  }
}
export async function temporalConnection() {
  return Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
    ...(process.env.TEMPORAL_API_KEY
      ? { tls: true, apiKey: process.env.TEMPORAL_API_KEY }
      : {}),
  });
}
