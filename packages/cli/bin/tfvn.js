#!/usr/bin/env node
import { existsSync } from "node:fs";
const compiled = new URL(
  "../../../dist/packages/cli/src/main.js",
  import.meta.url,
);
if (existsSync(compiled)) await import(compiled.href);
else {
  process.stderr.write(
    "TFVN has not been built. Run npm run build from the repository root.\n",
  );
  process.exitCode = 1;
}
