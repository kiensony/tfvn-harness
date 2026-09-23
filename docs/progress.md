# Execution ledger — plan: docs/implementation-plan.md

Source: the user supplied TFVN Harness product and architecture plan.

Ruling: the initial directory is empty and `.git` is a protected, empty placeholder.
Implementation proceeds in the supplied workspace without creating a Git branch; Git
workspace behavior is verified in disposable repositories. Cost if wrong: the user must
initialize/restore Git metadata before committing this implementation.

Ruling: use Node 24 and its built-in SQLite engine, npm workspaces and TypeScript.
This avoids native SQLite compilation while satisfying local durable storage.

Pre-flight: contracts feed providers, runtime, controller, CLI and cloud; one versioned
core package owns their schemas. Workspace and evidence identities share one fingerprint.
Local and remote transports share session event sequence semantics. Infrastructure tests
cannot establish production release readiness without provisioned services and credentials.

Tasks 1–4: local implementation present. Verified 37 tests including real Git worktrees,
command execution against a fixture bug, structured department handoffs and current-revision
review gates. Provider inference in tests uses wire fixtures or scripted adapters; it is
not a live model evaluation.

Ruling: the plan says both three total implementation/repair rounds and two routine
repair failures followed by another GPT-guided attempt. Enforce three total attempts,
with GPT escalation before the third. Cost if wrong: some tasks stop one attempt earlier.

Ruling: tracked secret files and unsupported snapshot entries block branch delivery after
snapshot preview. Silently excluding them would otherwise turn an excluded file into a
deletion in the delivered branch. Cost: repositories with tracked secrets/submodules need
a cleaned coding snapshot before modification work.

Tasks 5–7: CLI/Ink, authenticated cloud API, Temporal workflow/activity, PostgreSQL
leases and shared inference admission, GCS artifacts, Docker/gVisor backends, tool/MCP/
HTTP embedding interfaces, independent QA acceptance bundles, deployment templates and
operator/developer documentation implemented.

Final independent review found Git metadata trust, read-only command exposure, remote
budget reset, mutable resume inputs, completed-session re-execution, tool precondition
handling and preflight lease cleanup issues. Reproduction tests were added before fixes.
Git metadata is masked and validated; task materialization/commit avoid Git filters;
read-only command roles receive filtered worktrees; remote reservations persist across
attempts; phase inputs are immutable; completed results replay; known tool failures are
observations; preflight validation precedes lease acquisition.

Ruling: unsupported production gates remain explicitly pending in docs/release-status.md.
No cloud deployment, production release, live model review, benchmark success or branch
publication is claimed by mocked inference, simulated scheduling or local protocol tests.

Final verification: all 66 tests pass with zero skips while Docker, PostgreSQL 17 and
a local Temporal server are enabled. Type checking, compilation, formatting and all
120 deterministic routing cases pass. The sandbox image was built and executed;
its resolved immutable image ID is included in evidence. Real PostgreSQL admission
balances 32 runs across ten repositories and two owners, with 24 write slots and
per-repository caps. Temporal executes queued activities and persists blocked model
access truthfully. Mid-run corrections return through the coordinator and invalidate
prior evidence; cloud finalization cannot discard a concurrent user instruction.
The CLI smoke test also covers explicit read-only departments without command grants
in a directory without Git metadata. Infrastructure YAML and Terraform HCL parse;
the npm package dry run includes the compiled CLI and cloud entrypoints.
Both Docker images build. The control image bundles the compiled Temporal workflow
successfully with networking disabled. An interactive terminal smoke test verifies
explicit @designer ownership followed by a fresh @assistant default on an unmentioned
message. Temporary PostgreSQL and Temporal verification containers are stopped after
the checks; development images are retained for local setup.

Remaining scope is tracked in docs/release-status.md. Credentials and deployment
inputs were not supplied, so live models, GitHub publication and GCP infrastructure
have not been exercised by the harness. Following the user's source-publication
request, Git was initialized on `main` outside the protected workspace view for
publication through the GitHub CLI.
