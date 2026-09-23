import { proxyActivities, sleep } from "@temporalio/workflow";
import type { Activities } from "./activities.js";
const activities = proxyActivities<Activities>({
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5 seconds",
    maximumInterval: "60 seconds",
  },
});
// Workflow code contains no I/O, credentials, wall clocks, provider calls or repository data.
export async function executeRun(runId: string): Promise<void> {
  // Waiting for admission consumes a durable timer, never a worker slot.
  while (!(await activities.executeRun(runId))) await sleep("2 seconds");
}
