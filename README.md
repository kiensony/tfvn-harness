# TFVN Harness

A terminal coding harness with department routing, isolated Git workspaces and revision-bound evidence. Every unmentioned message starts at `@assistant`. Qwen handles coordination and development, GPT handles planning and architecture, and Claude provides independent QA and review.

**Status: internal development build (`0.1.0-dev.1`).** The repository includes a working local orchestration path, provider adapters, a CLI/Ink interface, a cloud control plane and deployment templates. It is not a production release. Live provider, deployed GKE/Temporal, disaster recovery and coding-quality release gates have not been certified. See [release status](docs/release-status.md) for exact limits.

## Quick start

Requires Node.js 24+, npm, and Git. Linux and macOS are the intended clients.

```bash
npm ci
npm run build
node packages/cli/bin/tfvn.js departments
node packages/cli/bin/tfvn.js run 'Explain this project' --mock --json
```

`--mock` is an offline, read-only demonstration. It does not claim to perform inference, edit code, or pass a model review. To install the local executable after building:

```bash
npm link
tfvn
```

Interactive mode requires a TTY. Noninteractive output supports versioned JSON events on stdout and diagnostics on stderr.

## Configure live models

Copy [the trusted configuration example](examples/trusted-config.yaml) to `~/.config/tfvn/config.yaml`, or select it with `--config`. Configure **verified account prices** as `inputPerMillion` and `outputPerMillion` for each provider; admission deliberately blocks when these are missing. The example omits prices because they depend on the endpoint and account.

Supply credentials to the harness process using `DASHSCOPE_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Never commit credentials. The default model IDs are `qwen3.8-27b`, `gpt-6-astra` and `claude-opus-5-5`; no automatic substitution occurs.

```bash
tfvn doctor
tfvn doctor --live  # Makes small billable model requests.
```

Without `--live`, doctor distinguishes configured credentials from tested model access. Even a successful live probe does not establish account quotas or coding quality.

## Run a coding task

Build a local coding image first. Commands run in a container with no network, no provider credentials, a read-only root filesystem and masked Git metadata.

```bash
docker build -f infra/Dockerfile.sandbox -t tfvn-sandbox:dev .
```

The target repository must have an initial Git commit and a `.tfvn/config.yaml` check profile. For example:

```yaml
schemaVersion: 1
checks:
  - name: tests
    command: [npm, test]
  - name: typecheck
    command: [npm, run, typecheck]
  - name: build
    command: [npm, run, build]
```

Use a project-specific image with dependencies already available. Coding containers cannot install packages from the internet. The supplied image has Node, Python and pytest; it does not contain your application's dependencies or Playwright browsers.

```bash
tfvn run '@dev fix the pagination bug' --allow edit,execute
tfvn run 'Build an account settings page' --allow edit,execute
tfvn run '@designer propose a clearer layout'
tfvn run '@qa check this branch' --allow execute
tfvn run 'Fix pagination' --allow edit,execute --snapshot working --include new-file.ts
```

The default snapshot uses committed tracked content. `--snapshot working` selects current tracked modifications; `--include` explicitly selects untracked files. The source checkout and index are preserved. Ignored files, secrets and symlinks are excluded. Tracked excluded entries block code delivery so exclusion cannot silently become a deletion in a delivered branch.

The result identifies a review worktree, branch, candidate revision, checks, reviews and artifact references. A failed check, unavailable specialist, expired budget, conflicting integration or stale evidence blocks completion. The implementation gets at most three attempts, with GPT revising the approach before the last attempt. There is no automatic merge or production deployment.

Use the [TypeScript](examples/typescript-api) or [Python](examples/python-api) fixture as a small live task. Copy it to a new directory, initialize and commit it with Git, then ask TFVN to fix pagination. Both fixtures intentionally contain a failing boundary test.

## Sessions and publication

```bash
tfvn status <session> --json
tfvn resume <session>
tfvn run 'Fix pagination' --allow edit,execute --pr
```

`--pr` explicitly requests branch publication and a draft GitHub PR through the host's `gh`/Git credentials. It checks the candidate, remote head and intended base. Retrying reconciles existing branches and PRs. Merging remains a human decision. Use a configured GitHub `origin` and an authenticated `gh` client.

Local state defaults to `~/.local/state/tfvn`; use `--state` or `TFVN_STATE_DIR` to override. SQLite stores events, checkpoints, usage reservations and operation results. Artifact filenames are SHA-256 content addresses. An interrupted side effect with uncertain completion blocks replay until a human inspects the workspace; the harness does not guess that rerunning is harmless.

Terminal controls: `/plan`, `/build`, `/test`, `/review`, `/team`, `/tasks`, `/diff`, `/context`, `/model`, `/budget`, `/permissions`, `/pause`, `/resume`, `/cancel`. `/model` lists assignments; `/budget` shows spending and limits; edit trusted settings between sessions to change them. `/permissions read,edit,execute` changes the current session's grants. Ctrl-C cancels active work, or exits when idle. `/context` expands detailed event traces. Messages sent during a run return through the coordinator, preserve existing work, and invalidate earlier requirements and evidence before delivery.

## Cloud development

```bash
tfvn run 'Fix pagination' --cloud --allow edit,execute
```

Configure the trusted cloud URL and `TFVN_CLOUD_TOKEN` first. A cloud request uploads only the selected portable file snapshot, never Git history or the active checkout. Remote results return patch and evidence artifacts. Downloaded artifacts are hash-verified and retained locally. Applying the patch and re-verifying the integrated local revision are required before publication; automatic cloud-to-local PR delivery is not enabled in this build.

See [cloud operations](docs/cloud-operations.md) for the PostgreSQL/Temporal development stack, GKE Sandbox deployment inputs, cancellation, fencing and restoration procedures. No infrastructure is provisioned by installation or ordinary local use.

## Development

```bash
npm run check
npm run eval:routing
npm run format:check
```

The suite exercises real temporary Git repositories, local fixture commands and HTTP boundaries. Provider tests use recorded wire shapes and scripted inference, not paid model calls. Optional integration tests use a disposable PostgreSQL database (`TEST_DATABASE_URL`), a development Temporal server (`TEMPORAL_TEST_ADDRESS`), and the built sandbox image (`RUN_DOCKER_TESTS=1`). CI enables all three. These integrations were also run locally: 66 tests passed with no skips, including container cancellation, real Temporal activity execution, and PostgreSQL admission across ten repositories. The 120-case routing evaluation measures deterministic ownership and scope hints, not live Qwen intent accuracy.

- [Architecture and API contracts](docs/architecture.md)
- [Adding departments, providers, tools and workflows](docs/extensions.md)
- [Cloud operation and recovery](docs/cloud-operations.md)
- [Release gates and remaining work](docs/release-status.md)
- [Implementation decisions and validation ledger](docs/progress.md)
