# Architecture

`packages/core` owns versioned contracts, configuration authority, sessions, workspaces, tools, budgets and workflows. `packages/providers` translates Qwen Chat Completions, OpenAI Responses and Anthropic Messages into one event stream. `packages/cli` exposes local/remote sessions. `packages/cloud` implements authenticated HTTP, PostgreSQL state, Temporal activities, content-addressed storage and gVisor jobs.

## Execution and authority

Deterministic dispatch scans only direct user messages. Code fences, inline code, blockquotes, quoted strings, emails and repository/tool text do not select departments. Multiple mentions keep `@assistant` as coordinator. Qwen then inspects repository evidence and emits a validated `RouteDecision`. Explicit ownership, read-only scope and mandatory sensitive workflows constrain that decision.

Project configuration controls model IDs, instructions, custom departments and check profiles. Trusted user configuration controls provider URLs, pricing, spending limits and approved network origins. User grants intersect department capabilities; repository files and model output cannot grant permission. Provider credentials remain in the controller process. A capability is checked again when the broker executes a tool.

Every model request has a reservation. Complete responses are persisted before any proposed tool executes. Completed operations replay their recorded result. A potentially executed operation with no durable result blocks automatic replay. Known precondition errors, such as an invalid patch, become tool observations. HTTP 429/503 retries are bounded; uncertain transport charges remain reserved. Provider continuation data stays in that provider's checkpoint, outside cross-department handoffs and exported public transcripts.

All modifying tasks use worktrees. Snapshot construction uses a temporary index and file-object hashing without clean filters. Task checkout writes blobs without smudge filters. Coding containers cannot replace `.git`, and the controller checks each task's Git pointer against the owning repository before committing or examining delivery state. Integration uses a separate workspace and a repository lease. Conflicts are reported, preserving the original checkout.

## Evidence

A `CheckRun` or `ReviewVerdict` binds the candidate commit, base, acceptance-criteria digest, check-profile digest, sandbox identity and harness version. Features and sensitive changes also require frozen independent acceptance tests derived by Claude from the baseline. Those tests are injected into a separate QA workspace and run read-only. Developer changes cannot replace that stored acceptance bundle.

The gate requires every configured check to pass and every required Claude department to approve the same identity without blocking findings. A code change changes the candidate identity. Reviewer phase inputs and task workspaces are persisted, so interrupted requests resume with the same prompt; changed candidates allocate new assessment tasks. A completed session returns its existing result on resume.

## Cloud contracts

The HTTP API supports:

| Endpoint | Contract |
| --- | --- |
| `POST /v1/runs` | Versioned request, repository key, mode, verified portable snapshot; idempotency key required |
| `GET /v1/runs/{id}` | Owner-scoped status, generation and result |
| `GET /v1/runs/{id}/events?after=N` | Ordered events strictly after cursor N; up to 1,000 per page |
| `POST /v1/runs/{id}/steer` | Append an authenticated user correction |
| `POST /v1/runs/{id}/cancel` | Fence current generation and cancel Temporal work |
| `POST /v1/approvals` | Human identity comes from authentication; scoped digest and expiry; idempotency required |
| `GET /v1/artifacts/{hash}?run={id}` | Owner-authorized result artifacts, verified by content hash |

API tokens map to principals and capabilities. Bodies have size bounds. Portable snapshots reject traversal, secret paths, duplicate paths, symlinks, unknown modes and mismatched content. Temporal workflow history carries run IDs; I/O stays in activities. PostgreSQL leases and generation numbers fence activity acceptance. Cloud inference admission shares reservations across workers and generations, checks run/daily dollars and provider request/token windows, and retains uncertain charges.

Cloud retries use a new generation directory. Expired workers cannot finalize, publish or update progress. Previously accepted results are not executed again. Provider keys are not mounted in sandbox jobs. Each job has a single task subdirectory, no service-account token, no capabilities, a read-only root, bounded CPU/RAM, gVisor, and denied ingress/egress. The controller is a trusted service outside the coding sandbox.

## Provider references

The adapters follow the [Qwen OpenAI-compatible API](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions), [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses), and [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming). Endpoint/model access, effort support and prices still require account-specific live verification. See also [Temporal TypeScript](https://docs.temporal.io/develop/typescript) and [Ink](https://github.com/vadimdemedes/ink).
