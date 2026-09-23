# Extension recipes

Build with `npm run build` before running `.mjs` examples importing `dist/packages/...`. Extensions are trusted application code; model-authored repository text is not an extension installer.

## Add a department

Project `.tfvn/config.yaml` can add profiles. Built-in names cannot be shadowed. New departments still need the user's grants, and cannot directly publish or upload.

```yaml
departments:
  - id: accessibility
    version: '1'
    model:
      provider: anthropic
      id: claude-opus-5-5
      effort: high
      contextTokens: 128000
    instructions: Inspect keyboard navigation, accessible names, focus order and contrast. Cite evidence.
    capabilities: [read]
    tools: [files, read, search, git_diff]
    scope: read
    outputContract: summary
```

Run `tfvn run '@accessibility inspect the settings page'`. To change a built-in model ID, use `models: {dev: qwen3.8-27b}`. Provider endpoint and pricing changes belong in trusted user settings, never project settings.

## Add a provider

Implement `ModelAdapter` from `core/src/model.ts`. `estimateUsage` must reserve a conservative cost, `stream` emits public text, complete tool calls, usage, and a terminal event, and `capabilities` must describe actual support. Never emit a successful terminal event after interruption, invalid tool JSON, refusal or truncation. Put opaque provider continuation data in `native`, tagged with the provider; do not place it in another department's prompt.

The Qwen/OpenAI/Anthropic tests illustrate fragmented SSE, usage, malformed arguments and signed continuation handling. Add equivalent fixtures before registering another provider in `adapterFor` and the versioned provider schema. This build explicitly reports image and provider-native structured-output support as unavailable; runtime JSON schemas validate department results after generation.

## Add a tool

```js
// example-tool.mjs, run from the repository root with node example-tool.mjs
import {z} from 'zod';
import {ExtensionRegistry} from './dist/packages/core/src/extensions.js';
const registry = new ExtensionRegistry();
registry.register({
  name: 'format_title', description: 'Format a supplied title.',
  schema: z.object({title:z.string()}).strict(),
  capability:'read', sideEffect:false, location:'broker',
  timeoutMs:1000, maxOutputBytes:1000,
  execute: async ({title}) => title.trim(),
});
console.log(await registry.execute('format_title',{title:' TFVN '},new AbortController().signal));
```

Pass this registry through `ControllerOptions.extensions` and add its name to the department tool list. Broker permission, argument validation, timeout and output limits still apply. An extension must honor its AbortSignal and accurately declare side effects. It cannot shadow a built-in tool.

`networkTools` adds `http_get` for trusted `allowedOrigins`. The HTTP broker resolves and pins a public IP, verifies TLS for the original host and refuses redirects and private networks. `HttpMcpTransport` plus `registerMcpTool` supports explicitly mapped MCP tools with locally supplied schemas and capabilities. Its current transport accepts JSON responses; MCP SSE and automatic tool discovery are not enabled. Server tool descriptions never define permissions.

`browserTestTool` runs a project's Playwright suite through the sandbox. Supply an image containing the exact browser and application dependencies. Browser screenshots remain ordinary workspace artifacts; automated visual/image reasoning is not implemented.

`runHooks` executes explicitly supplied hook commands in a read-only sandbox and blocks on failure. It is an embedding API; CLI YAML hook discovery is intentionally not enabled. Hooks never execute in the host shell.

## Add a workflow

Use `validateGraph` and `runGraph` from `controller.ts`. Nodes need unique IDs and declared dependencies. For example:

```js
import {runGraph} from './dist/packages/core/src/controller.js';
const nodes=[{id:'plan',dependencies:[]},{id:'dev',dependencies:['plan']}];
await runGraph(nodes,2,async node => console.log(node.id));
```

A new modifying workflow must end at `deliveryGate`. Add its required evidence explicitly; unavailable departments, errors and exhausted budgets cannot produce an approval. Persist immutable phase inputs before work begins and allocate new assessment IDs for changed identities. Never use a model's text as machine-generated check evidence.

## Check profiles

Use argument vectors, not a host shell string. Shell syntax can be explicitly requested as `['sh','-c', '...']`, but it still executes only inside the sandbox. Python examples use `python3 -m unittest -v`; TypeScript/JavaScript examples can use Node's test runner, npm scripts and a static/build command. Freeze the profile with the candidate's evidence identity. The configured image must contain dependencies; network installation inside coding containers is disabled.
