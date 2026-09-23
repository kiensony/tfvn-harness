# Release status

This build implements a substantial development baseline, not every production release criterion in the supplied roadmap.

| Area | Implemented | Verification / remaining gate |
| --- | --- | --- |
| Contracts and local sessions | Versioned types/schemas, YAML authority, SQLite journal, artifacts, budgets | Automated restart, fencing and budget tests |
| Provider runtime | Qwen, Responses and Messages streaming; private continuation state; bounded retries; tool checkpoints | Wire fixtures pass; live account/model/effort/quota validation pending |
| Department routing | Twelve defaults, custom profiles, explicit ownership, Qwen intent contract, scope validation | 120 deterministic labeled cases pass; live intent accuracy unmeasured |
| Local workflows | Requirements, task DAG, isolated implementation/integration, real checks, frozen independent acceptance tests, Claude review/QA/security gates, repairs | Executable fixture workflows pass using scripted inference; paid end-to-end model benchmark pending |
| Workspace safety | Temporary index snapshots, selected dirty/untracked content, binary files, conflicts, metadata fencing | Git tests pass; symlinks/submodules intentionally excluded and may block delivery |
| CLI / TUI | Interactive Ink, JSON events, status/resume, controls, doctor, offline demo | CLI regression tests; full interactive terminal/accessibility/manual UX evaluation pending |
| Publication | Candidate/base checks, non-force branch push, draft PR reconciliation | No live GitHub publication performed; remote base races keep work blocked/draft |
| Cloud durability | Authenticated API, Temporal workflow/activity, PostgreSQL generations, shared inference ledger, steering fences, GCS artifacts, gVisor job backend | Real PostgreSQL and Temporal activity tests pass; replacement workers restart from snapshots; checkpoint migration, deployed worker termination, service restart and restore tests pending |
| Capacity | Durable fair admission, 32/24/4 limits, integration leases, Temporal timers for waiting work | Real PostgreSQL admission across ten repositories passes; deployed 32-worker load/failure tests and delayed provider requeue remain incomplete |
| Extensions | Tool registry, permission-mediated typed MCP mappings, trusted HTTPS, browser-test and read-only hook embedding APIs | Unit boundaries tested; CLI MCP/hook discovery, full browser interaction and image reasoning remain incomplete |
| Context | Source-tagged repository instructions, session history, public handoffs, safe transcript compaction | Persistent repository/user fact retrieval and symbol index remain incomplete |
| Release evaluation | Deterministic suite, TS/Python bug examples, boundary/recovery tests | The 100-task human-reviewed coding benchmark has not been authored or run; no 85% success claim |
| Infrastructure / operations | Docker, Compose, GKE/storage/secret templates, CI, runbooks | Real GCP deployment, PostgreSQL operations, admission policies, telemetry exporter, backup restore and SLO validation pending |

Production release must remain disabled until the missing tests and operating controls are completed. No test fixture constitutes evidence of actual model quality, cloud availability, tenant isolation at scale, or production readiness. Merging and production deployment remain human-controlled.
