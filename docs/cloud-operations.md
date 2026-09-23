# Cloud operation and recovery

These are development deployment assets, not a validated production deployment. No credentials, GCP project, Temporal Cloud namespace or quota were supplied during implementation. An operator must provision and verify them before enabling remote users.

## Local control plane

```bash
docker compose -f infra/compose.yaml up -d
npm run build
docker build -f infra/Dockerfile.sandbox -t tfvn-sandbox:dev .
```

Export the values in `.env.example` through your normal secret-loading mechanism. Set `TFVN_CONFIG` to trusted provider settings with verified pricing. Set `TFVN_TOKENS` to a JSON array of principals containing a random token of at least 32 characters:

```json
[{"token":"REPLACE_WITH_A_RANDOM_32_OR_MORE_CHARACTER_SECRET","id":"developer","capabilities":["read","edit","execute","upload"]}]
```

Use the same value as the CLI's `TFVN_CLOUD_TOKEN`. Start the API with `npm run cloud` and the worker with `npm run worker`. Configure the CLI cloud URL as `http://127.0.0.1:8787`; plaintext is allowed only for loopback development. Both processes need the same PostgreSQL database and artifact location. Run the Docker worker on the host; do not mount the Docker socket into coding containers.

The API performs idempotent submission through Temporal. The CLI mirrors ordered events and persists its cursor. Ctrl-C disconnects cloud monitoring while remote work continues; `tfvn resume <session>` reconnects. Cancel explicitly through `POST /v1/runs/{id}/cancel` using the same principal token.

## GCP / Singapore

`infra/terraform` describes a private-node GKE Standard cluster with control and autoscaled gVisor node pools, Workload Identity, Cloud NAT, artifact storage and Secret Manager containers. It requires project, administrator CIDR and bucket inputs. Terraform has not been applied or provider-validated in this environment. Review the proposed resources, quotas and billing before deployment.

`infra/kubernetes/base.yaml` contains templates requiring replacement/configuration:

- `TFVN_CONTROL_IMAGE_DIGEST`: a built, scanned, digest-pinned controller image.
- `TFVN_CONTROL_GSA`: the provisioned Workload Identity service account.
- `tfvn-trusted-config`: a ConfigMap containing trusted `config.yaml` and verified prices.
- `tfvn-control-config`: Temporal address/namespace, `TFVN_SANDBOX_IMAGE` pinned by digest, `TFVN_ARTIFACT_BUCKET`, worker namespace and PVC settings.
- `tfvn-control-credentials`: database, Temporal and provider credentials supplied from Secret Manager by your approved secret-injection mechanism.
- `tfvn-api-credentials`: database, Temporal and API-principal credentials; provider keys are unnecessary here.
- Managed PostgreSQL connectivity, authenticated TLS ingress and the RWX Filestore storage class.

Do not expose the API directly without TLS. Restrict controller egress to approved model endpoints, Temporal, PostgreSQL, object storage and the Kubernetes API. Sandbox network denial is included; controller egress policy, admission policies restricting Job/PVC/image specifications, per-organization tenancy and managed-secret injection require deployment-specific configuration.

Workers use `TFVN_SANDBOX_BACKEND=kubernetes`. Sandbox jobs have no API token or provider credentials, mask `.git`, mount only one assigned task directory, and run with gVisor. The provided node labels/taints match generated jobs. The default resource profile is 2 vCPU/4 GiB. Browser/build-specific resource profiles still need load validation.

The database caps active runs at 32, writing runs at 24, and writing runs per owner/repository at four. Admission balances queued work across owners and repositories under a database lock. Each remote run performs one modifying task at a time. Waiting workflows use durable Temporal timers and release their activity slots. A real PostgreSQL concurrency test verifies 32 admitted runs across ten repositories and two users; this does not establish deployed 32-worker performance or isolation.

## Failure and recovery

Worker generation leases expire after 30 seconds and are heartbeated every five seconds. A replacement gets a fresh directory and restarts from the submitted snapshot; it does not resume an expired worker's SQLite checkpoint. Stale generations cannot finalize or admit new inference. Temporal retries activity failures; application-level blocks require a new authorized run or a human decision. Local uncertain side effects remain blocked rather than repeated. Steering is checked at model and delivery boundaries, and finalization is atomically fenced against unprocessed user messages.

Cloud inference reservations live in PostgreSQL, shared across workers and generations. Starter provider windows are 60 requests and 1,000,000 estimated tokens per minute, adjustable with `TFVN_PROVIDER_RPM` and `TFVN_PROVIDER_TPM` after validating actual account quotas. An exhausted admission window blocks the run in this build; automatic delayed re-admission is a remaining operating improvement. Never discard uncertain reservations solely to make a budget fit.

A remote completed change yields a binary-capable patch and evidence artifacts. The result records the original source base. Apply only to a matching isolated local snapshot, inspect the patch, integrate it, and run checks/review for the integrated revision before publication. Automatic cloud PR publication is not implemented.

Retain PostgreSQL backups with point-in-time recovery, Temporal history and versioned object storage. Restore them together into a separate environment, compare artifact hashes and event cursors, then perform a controlled failover. Initial targets remain 15-minute RPO, four-hour restoration, 60-second cancellation cleanup and 99.5% monthly control-plane availability; none has been measured yet.

Garbage collection must retain all artifacts referenced by sessions, active generations and delivered results. Stop expired jobs before removing their generation directories. The job TTL removes completed jobs after ten minutes; artifact/workspace retention requires an operator-reviewed cleanup policy. Do not recursively delete shared state or active worktrees to reclaim disk.

`@opentelemetry/api` spans mark cloud runs. Configure an SDK/exporter and collector in your deployment to export telemetry; installing this package alone does not send traces anywhere.
