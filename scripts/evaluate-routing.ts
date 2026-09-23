import { readFile } from "node:fs/promises";
import { dispatch } from "../packages/core/src/departments.js";
const data = JSON.parse(
  await readFile(
    new URL("../evals/routing/cases.json", import.meta.url),
    "utf8",
  ),
) as { cases: { message: string; owner: string; readonly?: boolean }[] };
let passed = 0;
for (const c of data.cases) {
  const result = dispatch(c.message);
  if (
    result.owner === c.owner &&
    (c.readonly === undefined || result.readonlyHint === c.readonly)
  )
    passed++;
  else process.stderr.write(JSON.stringify({ case: c, actual: result }) + "\n");
}
process.stdout.write(
  JSON.stringify(
    {
      suite: "deterministic-dispatch-v1",
      cases: data.cases.length,
      passed,
      accuracy: passed / data.cases.length,
      scope:
        "Deterministic ownership and read-only hints only; Qwen intent analysis is not evaluated.",
    },
    null,
    2,
  ) + "\n",
);
if (passed !== data.cases.length) process.exitCode = 1;
