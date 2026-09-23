import { spawn } from "node:child_process";
export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
export async function runProcess(
  argv: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    input?: string | Buffer;
    maxBytes?: number;
    onOutput?: (chunk: string) => void;
  } = {},
): Promise<ProcessResult> {
  if (!argv[0]) throw new Error("Empty command");
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let size = 0,
      reason: Error | undefined,
      killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(
          process.platform === "win32" ? child.pid : -child.pid,
          signal,
        );
      } catch {}
    };
    const stop = (error: Error) => {
      if (reason) return;
      reason = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () => stop(new Error("Command cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop(new Error("Command timed out")),
      options.timeoutMs ?? 300000,
    );
    timer.unref();
    const capture = (target: Buffer[]) => (buf: Buffer) => {
      size += buf.length;
      if (size > (options.maxBytes ?? 8_000_000)) {
        stop(new Error("Command output limit exceeded"));
        return;
      }
      target.push(buf);
      options.onOutput?.(buf.toString());
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    const clean = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (e) => {
      clean();
      reject(e);
    });
    child.on("close", (code) => {
      clean();
      if (reason) reject(reason);
      else
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
