# TFVN Harness implementation

The supplied product plan is authoritative. This is its executable decomposition.
This is an internal development build until live provider, sandbox, cloud recovery,
and human-reviewed coding benchmark release gates have passed.

1. Versioned contracts, safe configuration, department registry, deterministic dispatch,
   SQLite journal and content-addressed artifacts. Verify routing and restart persistence.
2. Streaming Qwen, Responses and Messages adapters; usage admission and shared tool loop.
   Verify fragmented streams, invalid responses, cancellation and uncertain operations.
3. Scoped tool broker, container commands, isolated Git snapshots and integration.
   Verify path/secret boundaries and preservation of staged/unstaged/untracked changes.
4. Adaptive workflow controller, Qwen routing, GPT planning, independent Claude review/QA,
   bounded repair cycles, and revision-bound delivery gates. Verify complete local workflows.
5. CLI, Ink terminal, sessions, JSON automation, doctor and controlled GitHub publication.
6. Cloud API, Temporal workflows, PostgreSQL state, fencing, quotas and worker interfaces.
   Verify idempotency, reconnect, cancellation, fairness and simulated 32-worker load.
7. Extension interfaces, deployment assets, examples and operational documentation.
8. Run all checks, fresh independent code review, repair actionable findings, report limits.

## Review focus

Permission authority must be outside repository and model input. No false success when
tests, provider access, QA or publication are unavailable. Revisions, requirements,
profiles and environments must match evidence. Stream failures must not execute partial
tool calls. Retries must not repeat uncertain side effects. Original checkout/index must
survive snapshots and parallel work. Late worker results must be fenced. Merges and
production deployment remain human-controlled.
