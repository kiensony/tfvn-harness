# PRD: Coding-run quality

**Product:** TFVN Harness `0.1.0-dev.1`  
**Status:** In progress. Checked items are implemented and covered by the automated suite. This document does not change `docs/release-status.md`, and it does not certify a production release.  
**Audience:** People implementing the next local-harness changes.

## Progress

- [x] FR-3.1 Journal finished model text; token deltas are live UI events only
- [x] FR-3.2 Reserve tokens at one per four prompt bytes; settle reported usage
- [x] FR-3.3 Invalid tool JSON, duplicate ids, and schema failures return to the model
- [x] FR-3.5 Long tool output keeps the first 8 KB, the last 24 KB, and the omitted byte count
- [x] FR-3.6 Parallel read-only tool results append in call order
- [x] FR-2.1 Isolate check side effects
- [x] FR-2.2 Stream check logs
- [x] FR-1.1 Protect baseline tests
- [x] FR-1.3 Apply that rule to small workflows
- [x] FR-1.2 Fixed acceptance runner
- [x] FR-3.4 Structured routing, planning, and assessment
- [x] FR-3.7 Ranged read, ripgrep search, exact multi-hunk patch
- [x] FR-3.8 Compact the full request
- [x] FR-4.1 Conflicts stay in the repair loop
- [x] FR-4.2 Write-intent route floor
- [ ] FR-4.3 Sensitive path globs
- [ ] FR-5.1 Streaming transcript
- [ ] FR-5.2 Sessions, grants, snapshot policy
- [ ] FR-5.3 Recorded base branch
- [ ] FR-5.4 Doctor fails when prices are missing
- [ ] FR-5.5 Project sandbox build
- [ ] FR-6.1 Scrub host Git
- [ ] FR-6.2 `tfvn gc`
- [ ] FR-7.1 Anthropic cache prices
- [ ] FR-7.2 IPv6 global unicast
- [ ] FR-7.3 Manual reservation settle

The control plane already keeps permission authority outside the repository and the model, snapshots the source checkout without destroying it, and refuses to report success when checks or reviews are missing. A real coding task still fails for the wrong reason, can satisfy its evidence by editing tests, and spends most of its time in a model loop that is too slow and too brittle to finish a non-trivial change.

This PRD specifies the changes that make a local coding run finish, prove the code works, and stay operable. Cloud scale, the human-scored benchmark, and production operations stay on the existing release list in [Release gates already tracked](#8-release-gates-already-tracked).

## Goals

1. A completed write run means the candidate passes the tests that existed before the model could edit them.
2. Check commands that write caches, coverage, or build output leave the candidate deliverable and inside the repair loop.
3. One department turn survives long output, bad tool JSON, and a context-length error without exhausting the budget or freezing the terminal.
4. A person can find a session, resume the grants they set, watch the model work, and publish against the branch that was current when the snapshot was taken.
5. Git operations that prepare a candidate run on the host without executing repository-controlled helpers. Publication remains an explicit `--pr` step.

## Non-goals

- Automatic merge or production deployment.
- Replacing Qwen, OpenAI, or Anthropic, or silently substituting model ids.
- Claiming coding-benchmark success. Scripted tests in this PRD are engineering tests. The 100-task human review remains a separate release gate.
- CLI discovery of MCP tools, image reasoning, or a symbol index. Those stay on the release-status list.
- Raising the cloud snapshot limit, worker checkpoint resume, or provider requeue. Those are named again in section 8 so they are not forgotten; this PRD does not specify their design.

## Users

- A developer running `tfvn run` or the Ink terminal on a Git repository with a `.tfvn/config.yaml` check profile.
- The same developer resuming a session, inspecting status, and optionally publishing a draft PR.
- An operator who runs `tfvn doctor` before a live session and who must reconcile a stuck budget reservation after a transport failure.

## Requirements

Priority is P0 (blocks a trustworthy coding run), P1 (blocks daily use), P2 (correctness that shows up once live traffic or untrusted repos are in play).

### 1. Evidence that the code works

**P0.** Current write workflows let `@dev` and `@test` edit the same worktree before the configured checks. On a `small` workflow there is no independent suite. On `feature` and `sensitive` workflows, `@qa` supplies both the files and the command. `ensureQa` accepts any argv that contains the acceptance path as one element, so a command can name the file and still exit 0 without running it. Acceptance files are not required to fail on the baseline.

#### FR-1.1 Protect baseline tests

**Done.**

Before any department receives a writable workspace, record the blob hash of every existing test file in the snapshot. The controller chooses which paths are tests from the check profile plus conventional test filenames (`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, and paths under `tests/` or `__tests__/`). Project config may add extra globs. Project config may not remove a path the conventions matched.

After the candidate commit, run those original blobs, read-only, against the candidate tree. Delivery requires that run to pass with exit code 0. A department that deletes, renames, or weakens a baseline test can still edit product code; the frozen blobs are what execute.

**Acceptance**

- The Python and TypeScript pagination fixtures fail their baseline tests on the starting commit and pass after a correct fix.
- A scripted model that only edits a baseline test, leaving the bug in place, finishes `blocked`. The blocker names the baseline-test check.
- The baseline-test check's evidence identity binds the candidate revision, the baseline blob digest, the check profile, the sandbox image id, and the harness version.

#### FR-1.2 Run independent acceptance with a fixed runner

**Done.**

For `feature` and `sensitive` workflows, `@qa` still writes acceptance files from the baseline, before implementation. The controller executes those files. The model-supplied command is ignored.

The runner is selected from the acceptance filenames:

| Files | Runner |
| --- | --- |
| `*.py` | `python3 -m unittest -v` on the installed files |
| `*.test.ts`, `*.test.js`, `*.spec.ts`, `*.spec.js` | `node --test` on the installed files |
| anything else | the phase fails with `unsupported acceptance runner` |

Acceptance is delivered only when the same files fail on a workspace checked out at the snapshot and pass on a read-only workspace checked out at the candidate. A pass on the baseline is a failed QA plan, and the planner/QA phase may retry once with the baseline log attached. A second pass on the baseline blocks the run.

**Acceptance**

- `["true", "<acceptance-path>"]` and `["node", "-e", "process.exit(0)", "<acceptance-path>"]` are not executed.
- A QA plan whose tests already pass on the baseline does not become an `independent-qa` pass.
- The candidate command runs with the sandbox read-only mount. The baseline command runs on a separate worktree.

#### FR-1.3 Keep small fixes on the same rule

**Done.**

`small` workflows do not invent an independent suite. They still run FR-1.1. A one-line bugfix cannot be completed by editing the existing test.

### 2. Checks that write files

**P0.** Configured checks run with a writable bind mount. `assertClean` then requires a porcelain-clean worktree. Pytest caches, coverage directories, and build output make that check throw. The throw is outside the repair loop, so a passing suite becomes a `blocked` session.

#### FR-2.1 Isolate check side effects

**Done.**

Run each configured check and the baseline-test command on a throwaway worktree created from the candidate commit. Mount that worktree so source modifications are detectable and disposable outputs do not touch the candidate workspace.

If the check changes a tracked source file or deletes a baseline test blob, record the check as `failed` with the dirty paths in the log. Leave the candidate worktree at the recorded commit. Return that failure to the repair loop as a blocker.

Cache, coverage, and build outputs on the throwaway worktree are discarded with it. They do not fail the run.

**Acceptance**

- A check that writes `__pycache__`, `.pytest_cache`, `coverage/`, or `dist/` and exits 0 completes the check as `passed` and leaves the candidate `git status` empty.
- A check that rewrites a tracked source file completes as `failed`. The session stays in the repair loop until attempt 3.
- `assertClean` still runs on the candidate workspace immediately before delivery and publication. It protects the evaluated commit. It is not the mechanism that absorbs test output.

#### FR-2.2 Stream check logs

**Done.**

Check stdout and stderr are journaled as coarse output events (at most one event per 200 ms, plus a final event) and stored in full in the check artifact. The repair prompt receives the tail of a failed log, up to 16 KB, and the artifact id of the full log.

### 3. Model loop

**P0** unless marked otherwise. These items share one turn of `AgentRuntime`.

#### FR-3.1 Journal finished text

**Done.** Deltas are not journaled. Each model turn appends one `model.completed` event.

`model.text` deltas are for the live UI. The SQLite event log records one `model.completed` payload per model turn, containing the full public text, tool-call names, usage, and the response artifact id. The UI may coalesce deltas to one render per 50 ms.

The session lease renewal continues to run during a long generation. A generation of several thousand tokens performs a constant number of journal transactions for that turn, plus tool and checkpoint writes.

**Acceptance**

- A scripted stream of 2,000 deltas appends fewer than 10 event rows for that turn.
- `tfvn status <session> --json` still shows the finished text after the process exits.

#### FR-3.2 Reserve tokens, then settle actual usage

**Done.** `estimateUsage` counts one token per four serialized prompt bytes and reserves `maxOutputTokens`. A usage event settles that cost even when the turn then fails while parsing a tool call.

`estimateUsage` counts tokens. Use a documented approximation of bytes/4 for input until a provider tokenizer is wired, and reserve the requested maximum output. Settle `actual` from provider-reported usage whenever a usage event was received, including when a later parse error fails the turn.

A reservation that has provider usage attached and then faults moves to `settled` at that reported cost. A reservation with no usage, after a dropped stream, stays `reserved` and counts toward the budget until a person reconciles it (FR-7.3).

**Acceptance**

- A prompt whose UTF-8 size is 40,000 bytes reserves about 10,000 input tokens plus `maxOutputTokens`, multiplied by the configured prices.
- A fixture that yields usage and then throws `ProviderError("Invalid tool arguments JSON")` settles the reported cost and leaves no `reserved` row for that request.
- Missing `inputPerMillion` or `outputPerMillion` still fails admission. `tfvn doctor` exits 2 in that case (FR-5.4).

#### FR-3.3 Return bad tool calls to the model

**Done.** Invalid tool JSON and duplicate call ids become tool observations. Unknown tools and schema failures already returned as observations. A stream that ends without a terminal event still executes nothing.

Invalid tool JSON, unknown tool names, schema failures, and duplicate call ids become tool observations. They do not abort the department. The observation is the string the model sees on the next step, and it consumes one step of the department budget.

Partial or interrupted streams still execute no tool. A stream that ends without a terminal event or without usage keeps the uncertain reservation and fails the turn.

**Acceptance**

- A scripted adapter that emits a tool call with arguments `"{not json"` produces a tool result whose content explains the parse failure, then accepts a corrected call on the next step.
- A stream that closes before `finish` executes zero tools.

#### FR-3.4 Force the structured phases

**Done.**

Routing, planning, and assessment each request one schema-constrained result. Prefer the provider's structured-output or a single required tool whose arguments are the phase object. When the provider reports structured output as unavailable, parse the text and, on failure, send one correction turn that contains the validation error. A second failure fails that phase with the validation error in the blocker.

`parseJson` remains the fallback parser. Prose around a fence is accepted on the first try when the fenced body is valid JSON. A second document in the same reply is a failure.

**Acceptance**

- A planner reply of `Here is the plan:\n```json\n{...}\n```` followed by a valid object is accepted.
- A planner reply of two JSON values fails the first attempt and succeeds when the correction turn returns one object.
- Two failed attempts end `blocked` with `Department did not return valid structured JSON` and the phase name.

#### FR-3.5 Keep the useful part of tool output

**Done.** Observations longer than 32 KB keep the first 8 KB, the last 24 KB, the omitted byte count, and the artifact id.

Tool observations shown to the model are capped at 32 KB. When the output is longer, the observation contains the first 8 KB, the last 24 KB, the omitted byte count, and the artifact id. The artifact stores the full output up to the existing process cap.

**Acceptance**

- A command whose failing assertion is in the last 100 lines still shows that assertion in the tool message when the log exceeds 32 KB.

#### FR-3.6 Order parallel reads

**Done.** Read-only calls still run up to eight at a time. Tool messages are appended in call order.

Read-only tool calls still run concurrently, up to 8 at a time. Their tool messages are appended in the order the model emitted the calls. A failure in the batch fails the turn after every call in that batch has either finished or been marked uncertain. Mutation tools remain serial.

**Acceptance**

- Two overlapping reads always produce tool messages in call-id order matching the assistant message.

#### FR-3.7 Give the department real edit tools

**Done.**

| Tool | Required behavior |
| --- | --- |
| `search` | Literal and regular-expression search, default literal. Skip binary files, secrets, and ignored files. Return path, line, and a short snippet. Default cap 100 matches, with an explicit truncated flag. Use `rg` when the sandbox image or the host provides it; otherwise keep an in-process scanner with the same result shape. |
| `read` | Read a UTF-8 file with optional inclusive `startLine` / `endLine`. Default to the first 400 lines when the file is larger than 256 KB, and include the total line count. |
| `patch` | Replace one exact occurrence. On zero or many matches, return a `ToolInputError` observation that includes the match count and the first and last line numbers of matches. Support a multi-hunk patch in one call, each hunk exact-once. |

Search remains available on read-only runs that have no sandbox. It never shells out to a repository-configured program.

**Acceptance**

- `search` on a fixture repo returns a match past line 100 when the cap is raised, and reports `truncated: true` at the default cap.
- `read` of a 2,000-line file with `startLine: 1800` returns the tail.
- `patch` with two matches returns an observation and does not modify the file.

#### FR-3.8 Compact the full request

**Done.**

The compaction threshold counts the system prompt, tool schemas, and messages that will be sent. Compare that size with the department `contextTokens` using the same bytes/4 approximation as admission. When the request crosses 70% of the window, summarize older public assistant text with the department model into one user message, keep every user requirement message, and keep the last two complete assistant/tool exchanges. Provider continuation objects stay only on the retained exchanges.

A provider context-length error settles known usage, compacts once, and retries the turn. A second context-length error fails the turn with `Context cannot be compacted`.

**Acceptance**

- A fixture whose system prompt alone exceeds the threshold compacts before the first request.
- One scripted context-length error is followed by a shorter request that succeeds.

### 4. Repair and routing

**P1.**

#### FR-4.1 Keep conflicts and later rounds in the loop

**Done.**

A cherry-pick conflict records the conflict paths and the integration workspace, then becomes the repair prompt. It does not throw out of the attempt loop. Attempts remain capped at 3. Attempt 3 still requests an architect revision before the repair department runs.

The repair department is the department that owned the failed task. A single integrated candidate with several task owners is repaired by `@dev` only for tasks whose owner was `@dev`; designer, docs, devops, and test tasks return to those departments. The controller passes the failed check tails, review findings, and conflict paths from FR-2.2.

**Acceptance**

- A two-task graph whose second cherry-pick conflicts is still inside the loop with `round` unchanged and a blocker that lists the conflicted paths.
- A `designer` task whose check fails is repaired by `@designer`, which is visible on the `handoff` event.

#### FR-4.2 Floor the route on write intent

**Done.**

When the user grants `edit` and `execute`, and the active user text contains a change verb (`implement`, `build`, `fix`, `change`, `update`, `write`, `create`, `apply`) and does not contain a read-only override (`propose`, `explain`, `describe`, `investigate`, `inspect`, `discuss`, `suggest`, or the phrase `design only`), `validateRoute` requires `scope: write` and a workflow other than `readonly`.

When the grants are missing, the same text finishes `blocked` with a blocker that names the missing capability, before any model call.

Explicit `@qa`, `@review`, `@planner`, `@architect`, `@security`, or `@research`, and the slash commands `/plan` and `/review`, keep their current read-only ownership.

**Acceptance**

- `fix the pagination bug` with `--allow edit,execute` is rejected when the routed workflow is `readonly`.
- `explain the pagination bug` with those grants remains eligible for a read-only route.
- `@review check this branch` remains read-only.

#### FR-4.3 Upgrade sensitive work before the first write

Sensitive paths come from `.tfvn/config.yaml` `sensitivePaths` globs. The default globs are:

```yaml
sensitivePaths:
  - "**/*auth*"
  - "**/*permission*"
  - "**/*migrat*"
  - "**/*schema*"
  - "**/terraform/**"
  - "**/.github/**"
  - "**/*rbac*"
  - "**/*policy*"
```

A project may add globs. The default list stays in force. Matching is on repository-relative paths, case-insensitive, and uses path segments so `author.ts` does not match `*auth*` and `docs/author.md` does not match `*auth*`.

When the planned writes are not yet known, the upgrade runs after the candidate diff exists and before the next repair or the review phase. The first implementation attempt may already have happened for a diff the router did not flag. In that case the run upgrades to `sensitive`, requests the architect contract, and requires `@security` on the final identity. The attempt counter does not reset.

**Acceptance**

- `src/author.ts` does not upgrade the workflow.
- `src/auth/session.ts` and `deploy/policy.json` upgrade it to `sensitive` and add a `@security` review on the delivered identity.
- A custom extra glob in project config matches in addition to the defaults.

### 5. Terminal, sessions, and sandbox image

**P1** unless marked otherwise.

#### FR-5.1 Show the work

The interactive transcript and the non-JSON CLI render model text as it arrives, and they render command and check output as coarse events from FR-2.2. The Ink transcript scrolls. It retains the session, not the last 30 lines. `/context` still toggles raw event details.

**Acceptance**

- During a scripted run, the terminal process prints a model delta before the department completes.
- A check that runs longer than 1 second prints at least one output line before it exits.

#### FR-5.2 List and restore sessions

`tfvn sessions` prints local sessions from the journal, newest first: id, repository, status, updated time. `tfvn status <session>` stays the detailed view.

`/permissions` writes the session `options` checkpoint before it returns. Resume without a new `--allow` uses that checkpoint. Resume with `--allow` replaces grants for that invocation and writes the checkpoint.

The interactive session records the snapshot policy. `/snapshot head` and `/snapshot working`, plus `/include <path>`, are accepted only while no run is active. They update the policy used by the next execute.

**Acceptance**

- After `/permissions read,edit,execute`, a new process running `tfvn resume <session>` still has those grants.
- `tfvn sessions --json` returns every session the journal has, up to the existing 100-row cap.

#### FR-5.3 Remember the base branch

Snapshot creation records `baseBranch` from `git branch --show-current` and the base commit. Publication uses that recorded name and commit. A later checkout of another branch in the source repo does not change the PR base.

An empty recorded branch (detached HEAD at snapshot time) fails publication with `Select an intended base branch before publication` before any push.

**Acceptance**

- Snapshot on `main`, then `git checkout` another branch, then `tfvn resume <session> --pr`, opens the draft PR against `main` at the snapshotted commit.
- Publication still refuses a remote `main` that has moved, as it does today.

#### FR-5.4 Doctor fails closed on prices

`tfvn doctor` exits 2 when a configured provider is missing `inputPerMillion` or `outputPerMillion`. The check name is the provider, and the detail says pricing is required before live admission. `--live` behavior is unchanged: a live probe runs only when credentials and prices are present.

#### FR-5.5 Build a project sandbox image

`tfvn sandbox build` builds an image for the current repository. The Dockerfile is, in order:

1. `.tfvn/Dockerfile` when present.
2. Otherwise a generated Dockerfile `FROM` the configured `sandboxImage` that copies the lockfile and installs dependencies with network enabled only during this build.

The command prints the resulting image id. `tfvn run` and `tfvn doctor` use that id when `.tfvn/sandbox-image` contains an id produced by this command and `docker image inspect` still resolves it. A missing or stale id falls back to `sandboxImage` and doctor reports `project sandbox image missing`.

The coding container stays network-none. The build command is the only step that installs packages.

**Acceptance**

- A fixture with `package-lock.json` and a check of `npm test` passes inside the built image with `--network=none`.
- `docker history` of the running container's image id matches the id recorded in check evidence.

### 6. Host Git boundary and workspace cleanup

**P1** for cleanup, **P2** for the config boundary. The sandbox already drops hooks, disables smudge/clean during snapshot and checkout, and masks `.git` inside the container. Host `git` still carries the controller environment and the repository's local config, and integration still cherry-picks on the host.

#### FR-6.1 Scrub host Git

Every Git invocation except the publication push uses:

- an environment that contains `PATH`, `HOME`, `GIT_*` overrides, and locale, and omits provider API keys and cloud tokens;
- `credential.helper` cleared, `diff.external` cleared, `core.sshCommand` cleared, `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `protocol.file.allow=never`, and attribute-defined merge drivers and filters disabled for that invocation.

`git push` during `--pr` may use the user's normal credential helper. It still uses the scrubbed environment so a helper receives Git's own prompt variables and not `DASHSCOPE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `TFVN_CLOUD_TOKEN`.

**Acceptance**

- A repository-local `credential.helper` or merge driver is not executed during snapshot, worktree add, status, diff, commit, or cherry-pick. The test uses a helper that would create a marker file.
- A publication push still reaches the remote when the user has a working `gh`/`git` credential outside the repository config.

#### FR-6.2 Garbage-collect harness refs

`tfvn gc` removes worktrees and branches under `tfvn/` created by this harness whose sessions are `completed`, `cancelled`, `failed`, or `blocked`, and whose worktrees are not the current publication target. It deletes `refs/tfvn/snapshots/*` that no remaining session checkpoint references. It refuses to delete a worktree with a dirty porcelain status unless `--drop-dirty` is passed.

**Acceptance**

- After a finished fixture run, `tfvn gc` removes that run's worktree and `git worktree list` no longer contains it.
- An active `running` session's worktree remains.

### 7. Budgets and small provider fixes

**P2.**

#### FR-7.1 Price Anthropic cache tokens separately

Trusted provider settings gain optional `cacheReadPerMillion` and `cacheWritePerMillion` for Anthropic. Cache-read and cache-creation tokens use those rates when set. When they are unset, doctor reports them as unset and admission uses `inputPerMillion` for both, which is the current behavior, and the usage record marks `cachePricedAsInput: true`.

#### FR-7.2 Accept IPv6 global unicast

`publicAddress` treats an address as public IPv6 only when it is in `2000::/3`, and still rejects IPv4-mapped, loopback, link-local, multicast, and unique-local addresses. Addresses in `3000::/4` that are global unicast are allowed.

#### FR-7.3 Reconcile a stuck reservation

`tfvn budget <session>` prints each reservation: id, task, state, estimated amount, actual amount, day. `tfvn budget settle <reservation-id> --actual <dollars>` settles a `reserved` row. The command requires an interactive confirmation unless `--yes` is set. It does not delete the row. Automatic discard stays unavailable.

**Acceptance**

- A row left `reserved` by a dropped stream is excluded from `reserved` spend after a confirmed settle and included in `settled` spend at the confirmed actual.

### 8. Release gates already tracked

These remain release blockers. This PRD does not redefine them.

| Gate | Requirement to close it |
| --- | --- |
| Coding quality | Author and run the 100-task human-reviewed benchmark. Publish the score with the harness version, model ids, and spend. No success claim before that run. |
| Live providers | `tfvn doctor --live` passes for the configured accounts, including effort and a quota check. Record the date and model ids. |
| Cloud resume | A replacement worker continues the task checkpoint. Expired generations still cannot finalize. |
| Provider windows | Exhausted RPM/TPM delays and readmits the run. It does not block the session for the rest of the day. |
| Snapshot size | A repository above 32 MB uploads as a chunked or filtered tree and reassemblies to the same manifest digest. |
| Telemetry and recovery | An OpenTelemetry exporter is configured, and a backup/restore drill meets the stated RPO/RTO targets on a non-production stack. |
| Journal schema | `user_version` migrates forward. Existing sessions open after upgrade. |

## Sequencing

Implement in this order. Each item is independently mergeable and keeps the current safety rule: an uncertain mutation is not replayed, and a missing check is not a pass.

1. FR-3.1, FR-3.2, FR-3.3, FR-3.5, FR-3.6. The loop stops losing budget and freezing the terminal.
2. FR-2.1 and FR-2.2. Checks survive their own output and feed repair.
3. FR-1.1 and FR-1.3, then FR-1.2. Evidence matches the code.
4. FR-3.4, FR-3.7, FR-3.8. Departments can see and edit a real repository.
5. FR-4.1 and FR-4.2, then FR-4.3.
6. FR-5.1 through FR-5.5.
7. FR-6.1, FR-6.2, FR-7.1 through FR-7.3.

Section 8 stays outside this sequence until the inputs it requires (accounts, a benchmark set, a GCP project) are available.

## Verification

- `npm run check`, `npm run eval:routing`, and `npm run format:check` pass.
- New tests cover each acceptance bullet with scripted adapters and temporary Git repositories. Live model calls stay out of the default suite.
- The pagination fixtures are the smoke task for FR-1 and FR-2: baseline red, correct patch green, test-only patch blocked, cache-writing check still deliverable.
- `tfvn doctor` against the example trusted config fails on missing prices and says so.

## What stays true

User grants still intersect department capabilities. Repository files, project instructions, and model output still cannot grant permission. Provider credentials stay in the controller process. Coding containers stay network-none, with a read-only root and a masked `.git`. Publication stays explicit, draft, and human-merged. A completed session returns its recorded result on resume until new user instructions invalidate that evidence.
