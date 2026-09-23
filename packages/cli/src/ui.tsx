import React, { useState, useRef } from "react";
import { Box, Text, useInput, useApp, render } from "ink";
import { Controller } from "../../core/src/controller.js";
import { dispatch } from "../../core/src/departments.js";
import { git } from "../../core/src/workspace.js";
import {
  capabilitySchema,
  type SessionEvent,
  type TaskResult,
} from "../../core/src/contracts.js";
import { describe, terminalText } from "./output.js";
export async function terminal(
  controller: Controller,
  sessionId: string,
): Promise<void> {
  const app = render(<App controller={controller} sessionId={sessionId} />);
  await app.waitUntilExit();
}
function App({
  controller,
  sessionId,
}: {
  controller: Controller;
  sessionId: string;
}) {
  const { exit } = useApp();
  const [input, setInput] = useState(""),
    [lines, setLines] = useState<string[]>([
      "TFVN Harness · @assistant is the default for every message.",
      "/team /tasks /diff /context /model /budget /permissions /pause /resume /cancel",
    ]);
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<TaskResult>(),
    [spend, setSpend] = useState(0),
    [showTrace, setShowTrace] = useState(false);
  const current = useRef<AbortController | undefined>(undefined),
    steering = useRef<string[]>([]),
    running = useRef(false);
  const print = (text: string) =>
    setLines((prev) => [...prev, text].slice(-30));
  controller.options.onEvent = (event: SessionEvent) => {
    const line = describe(event);
    if (line) print(line);
    else if (showTrace && event.type !== "model.text")
      print(JSON.stringify(event.payload));
    setSpend(controller.options.journal.spending(sessionId).settled);
  };
  const launch = async (text: string, resume = false) => {
    if (running.current) {
      steering.current.push(text);
      controller.options.journal.append(sessionId, "steering", { text });
      print(
        "Instructions queued for the coordinator; requirements and evidence will be reassessed.",
      );
      return;
    }
    running.current = true;
    setBusy(true);
    current.current = new AbortController();
    try {
      controller.options.journal.append(sessionId, "message", { text });
      setResult(
        await controller.execute(sessionId, text, {
          resume,
          signal: current.current.signal,
          steering: () => steering.current.splice(0),
        }),
      );
    } catch (e) {
      print(String(e));
    } finally {
      running.current = false;
      setBusy(false);
      current.current = undefined;
    }
  };
  const submit = async (text: string) => {
    if (!text.trim()) return;
    print(`> ${text}`);
    const [command, ...args] = text.trim().split(/\s+/);
    if (command === "/pause" || command === "/cancel") {
      current.current?.abort(
        new Error(command === "/pause" ? "paused" : "cancelled"),
      );
      return;
    }
    if (command === "/resume") {
      if (busy) {
        print("Wait for the current command to finish stopping.");
        return;
      }
      await launch("", true);
      return;
    }
    if (command === "/team" || command === "/model") {
      print(
        Object.values(controller.options.config.departments)
          .map((d) => `@${d.id} · ${d.model.id} · ${d.model.effort}`)
          .join("\n"),
      );
      return;
    }
    if (command === "/budget") {
      print(
        JSON.stringify({
          task: controller.options.config.limits.taskDollars,
          session: controller.options.config.limits.sessionDollars,
          ...controller.options.journal.spending(sessionId),
        }),
      );
      return;
    }
    if (command === "/permissions") {
      if (args.length && busy) {
        print("Change permissions between runs.");
        return;
      }
      if (args.length)
        controller.options.grants = [
          ...new Set([
            "read" as const,
            ...args
              .join(",")
              .split(",")
              .map((x) => capabilitySchema.parse(x)),
          ]),
        ];
      print(`Granted: ${controller.options.grants.join(", ")}`);
      return;
    }
    if (command === "/tasks") {
      const event = controller.options.journal
        .events(sessionId)
        .filter((e) => e.type === "task.graph")
        .at(-1);
      print(
        event ? JSON.stringify(event.payload, null, 2) : "No task graph yet.",
      );
      return;
    }
    if (command === "/context") {
      setShowTrace((v) => !v);
      print(
        showTrace
          ? "Detailed events hidden."
          : "Detailed events expanded. Session decisions and evidence are preserved in the journal.",
      );
      return;
    }
    if (command === "/diff") {
      if (!result?.workspace) {
        print("No candidate workspace yet.");
        return;
      }
      try {
        print(
          (
            await git(result.workspace, [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              result.checks[0]?.identity.base ?? "HEAD",
            ])
          ).slice(0, 24000) || "No changes.",
        );
      } catch (e) {
        print(String(e));
      }
      return;
    }
    dispatch(text);
    await launch(text);
  };
  useInput((text, key) => {
    if (key.ctrl && text === "c") {
      if (current.current) current.current.abort(new Error("cancelled"));
      else exit();
      return;
    }
    if (key.ctrl && text === "d" && !busy) {
      exit();
      return;
    }
    if (key.return) {
      const value = input;
      setInput("");
      void submit(value).catch((e) => print(String(e)));
    } else if (key.backspace || key.delete) setInput((v) => v.slice(0, -1));
    else if (!key.ctrl && !key.meta)
      setInput((v) => (v + text).slice(0, 50000));
  });
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          TFVN Harness · {busy ? "working" : "ready"} · ${spend.toFixed(4)}
        </Text>
        <Text dimColor>{controller.options.repository}</Text>
        <Text dimColor>
          Session {sessionId}
          {result?.branch ? " · " + result.branch : ""}
        </Text>
      </Box>
      {lines.map((line, i) => (
        <Text key={i}>{terminalText(line)}</Text>
      ))}
      <Box marginTop={1}>
        <Text color="cyan">{busy ? "steer > " : "> "}</Text>
        <Text>{terminalText(input)}</Text>
      </Box>
    </Box>
  );
}
