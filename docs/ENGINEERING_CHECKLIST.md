# Bob engineering checklist

Updated: 2026-08-11

Repository baseline: `ba91b0b`

Working-tree review: pending commit and production release
Source: [Production LLM engineering checklist](https://x.com/divaagurlxw/status/2086501951387422991)

This document tracks Bob's production agent engineering work.

The status table includes tested code in the current working tree.

Production evidence remains separate. A checked implementation item is not production proof.

## Status rules

- **Strong**: Bob has the implementation, tests, and required production evidence.
- **Covered**: The item is complete for Bob's declared scope.
- **Partial**: Some required implementation or production evidence is missing.
- **Missing**: Bob has no effective implementation.
- **Provider-managed**: OpenAI owns this part of the hosted inference stack.

Current summary:

- Strong or covered: 5
- Partial: 11
- Missing: 1
- Provider-managed: 5

## Engineering checklist

| ID  | Area                                    | Status               | What Bob has                                                                                                                     | Missing or next proof                                                                  |
| --- | --------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 01  | Agent harness                           | **Strong**           | Durable runs, encrypted snapshots, queues, leases, outbox records, retries, and dead-letter queues.                              | Keep fault tests in the release gate.                                                  |
| 02  | Context engineering                     | **Partial**          | A bounded pack has confirmed facts, lexical matches, active reminders, routines, and workout state.                              | Prove selection quality with live requests. Stored raw conversation stays excluded.    |
| 03  | Prompt and semantic caching             | **Missing**          | ADR 0006 defines safe keys, privacy rules, invalidation, and required measurements.                                              | Measure repeated eligible reads. Implement only when the measured benefit is material. |
| 04  | KV-cache management                     | **Provider-managed** | OpenAI operates the hosted model cache.                                                                                          | Reassess only if Bob self-hosts inference.                                             |
| 05  | Prefill and decode latency              | **Provider-managed** | Bob records total model latency.                                                                                                 | OpenAI owns separate prefill and decode behavior.                                      |
| 06  | Continuous batching and paged attention | **Provider-managed** | OpenAI operates the serving infrastructure.                                                                                      | Reassess only if Bob self-hosts inference.                                             |
| 07  | Speculative decoding and distillation   | **Provider-managed** | These controls are unavailable through the hosted Codex path.                                                                    | Reassess only if the inference platform changes.                                       |
| 08  | Quantization                            | **Provider-managed** | OpenAI selects inference formats.                                                                                                | Evaluate INT8, INT4, FP8, AWQ, or GPTQ only for self-hosted models.                    |
| 09  | Structured outputs and repair           | **Partial**          | Effect validates strict assistant JSON. Bob permits one repair and rejects unsafe action claims.                                 | Prove repair and rejection behavior with the production model.                         |
| 10  | Function-call reliability               | **Strong**           | Bob validates tools twice. It uses command hashes, leases, approvals, and durable idempotency.                                   | Prove each domain tool in production.                                                  |
| 11  | Agent guardrails                        | **Strong**           | Bob limits turns, tools, time, output, run tokens, and daily tokens.                                                             | Verify soft token-budget alerts in production.                                         |
| 12  | Model routing and fallback              | **Partial**          | Bob uses one approved Codex model. It can return safe, source-labelled, read-only degraded recall.                               | Measure failures before adding a second model route.                                   |
| 13  | Retrieval-augmented generation          | **Partial**          | Owner-scoped FTS5 adds sources, task state, diversity, and bounded event recency.                                                | Measure live quality. Add embeddings only after privacy review and a proven gain.      |
| 14  | Retrieval evaluation                    | **Partial**          | A synthetic gate measures recall, precision, grounding, citations, conflicts, and stale leakage.                                 | Connect observations to the real retrieval path and run a private acceptance set.      |
| 15  | Agent evaluations                       | **Partial**          | The root check runs 11 versioned cases and 13 strict metrics. A bounded live runner is opt-in.                                   | Add production shadow results and drift history without storing private text.          |
| 16  | LLM observability                       | **Partial**          | Reusable Effect Layers trace Workers, Pi turns, model calls, tools, repairs, reminders, and delivery. Loki and Grafana are live. | Release the exporters. Prove one full trace, SLO queries, and alert delivery.          |
| 17  | Cost and quota attribution              | **Partial**          | Durable usage records attribute tokens by feature, workflow, model, run, and UTC day.                                            | Verify live quota alerts. Codex subscription use has no per-token cost value.          |
| 18  | Safety and permissions                  | **Strong**           | Bob taints recalled data and tool results. It scans output and verifies sources, tools, and actions.                             | Keep adversarial output tests in the release gate.                                     |
| 19  | Tenant isolation                        | **Covered**          | Bob is a single-owner system. Stored data and actions still require the owner identity.                                          | Reopen this item before adding a helper or another owner.                              |
| 20  | Fine-tuning, prompting, and RAG choice  | **Partial**          | Prompting and lexical retrieval fit private changing data. The synthetic gate records a baseline.                                | Record live evidence. Do not fine-tune on personal records.                            |
| 21  | Latency, quality, cost, and reliability | **Partial**          | Bob has spans, strict quality gates, run limits, feature quotas, and defined service objectives.                                 | Verify objective queries, alerts, and dashboards with production data.                 |
| 22  | Production failure modes                | **Partial**          | Tests cover invalid tools, stale recall, prompt injection, unsafe output, repair, and safe fallback.                             | Add model-drift history and production fault drills.                                   |

## Current production evidence

Snapshot date: 2026-08-11

- [x] The Kubernetes agent is healthy.
- [x] The Cloudflare tunnel is healthy.
- [x] The stable Core host and authenticated agent-to-Core path are healthy.
- [x] Sendblue has one receive webhook and one outbound webhook.
- [x] Six inbound messages reached durable storage.
- [x] Five model runs completed.
- [x] Six outbound responses reached `delivered` state.
- [x] No delivery is failed, uncertain, claimed, or dead-lettered.
- [x] Production records model token counts and latency.
- [x] Redacted production agent logs reach Loki.
- [x] The Bob production dashboard shows pod health, logs, failures, and Tempo searches.
- [x] The native agent OTLP exporter sent a content-free live test trace to Tempo.
- [ ] The running production agent image exports native traces.
- [ ] Cloudflare Worker logs and traces export to the private LGTM stack.
- [ ] A domain tool has run in production.
- [ ] A reminder has completed its full production lifecycle.
- [ ] A confirmed memory has been recalled with its source.
- [ ] A journal entry has passed create, retrieve, and delete checks.
- [ ] A gym, routine, workout, and set have completed their full workflow.
- [ ] An independent encrypted backup has completed.
- [x] A primary-data restore drill measured recovery time and recovery point loss.
- [ ] End-to-end production traces, SLOs, and alert delivery have been verified.

## Current release gate

- [ ] Commit and push the complete source, migrations, manifests, and tests.
- [ ] Publish the agent and backup images from that release SHA.
- [ ] Verify both image attestations, then pin both immutable digests.
- [ ] Run the trusted production Cloudflare plan for the release SHA.
- [ ] Reject any unexpected Worker, D1, R2, Queue, Durable Object, or Access replacement.
- [ ] Deploy the backward-compatible agent before the new Core Worker.
- [ ] Drain old agent runs before the Core Worker update.
- [ ] Keep the stable `bob.tpops.dev` Core address through the cutover.
- [ ] Wait for External Secrets, then restart and verify the agent after the handoff.
- [ ] Pin Argo CD to the reviewed release SHA and verify a healthy sync.
- [ ] Run one manual encrypted backup and verify its archive manifest.
- [ ] Complete Better Auth owner setup and a new sign-in.
- [ ] Complete one harmless live acceptance check for each domain.
- [ ] Copy encrypted backup archives to node-independent storage.

## Product workflow checklist

### Reminders

- [x] Store encrypted one-shot reminders and occurrences.
- [x] Use scheduler outbox records and Durable Object alarms.
- [x] Enforce quiet hours and the daily delivery limit.
- [x] Bind `SEEN` and `DONE` to one reminder occurrence.
- [x] Pass the current source message ID to the agent tool contract.
- [x] Give the model the user's local time, locale, time format, and IANA time zone.
- [x] Expose executable list, create, snooze, seen, done, and cancel tools.
- [x] Expose exact-target reminder actions in the private UI.
- [ ] Support recurring reminder creation through the user interface.
- [ ] Complete one live create, deliver, seen, done, snooze, and cancel test.

### Memory and retrieval

- [x] Stage candidates for owner confirmation.
- [x] Store revisions, evidence, conflicts, and supersession history.
- [x] Encrypt sensitive values and exclude ineligible data from model context.
- [x] Provide lexical FTS5 search.
- [x] Pass the current source message ID through the agent request and prompt.
- [x] Add active reminder, routine, and workout state to context selection.
- [x] Keep stored raw conversation out of Pi. Use confirmed, source-labelled records instead.
- [x] Bind agent proposals to the verified owner message. Ignore model-supplied provenance.
- [x] Make confirm, correct, and reject terminal across retries and concurrent reviews.
- [x] Make owner-reviewed, low-risk records eligible for FTS and model recall.
- [x] Add an executable, owner-bound memory-correction flow.
- [x] Build a synthetic retrieval evaluation corpus before adding embeddings.
- [ ] Add hybrid retrieval only when evaluation shows an improvement.
- [ ] Complete one live remember, confirm, recall, correct, and `why` test.

### Journal

- [x] Use a short-lived, single-use private handoff.
- [x] Encrypt raw journal text.
- [x] Keep raw journal text and approved summaries outside Pi and Sendblue.
- [x] Give Pi only journal dates and tags. Keep entry IDs in the owner UI.
- [x] Remove derived data when its source is deleted.
- [x] Add owner-bound journal editing.
- [ ] Add encrypted attachments and use the existing R2 bucket.
- [x] Add a user-started Obsidian-compatible index export with approved summaries only.
- [ ] Complete full-owner privacy deletion.
- [ ] Complete one live create, search, read, export, and delete test.

### Training

- [x] Store gyms, equipment, exercises, mappings, routines, workouts, and sets.
- [x] Require exact owner approval for training mutations.
- [x] Stop the workflow after pain, injury, or machine confusion signals.
- [x] Add routine, last-workout, and workout-history lookup tools.
- [x] Add explicit assistant list tools for gyms, equipment, and exercises.
- [x] Preserve IDs across multi-message gym setup through owner-scoped lookup tools.
- [x] Add searchable routine, equipment, active-workout, and history views to the UI.
- [ ] Encrypt sensitive training names, notes, and workout records.
- [ ] Complete one live gym setup, routine, workout, set, and finish test.

## Priority backlog

### P0: Make the current product dependable

- [x] Fix source message, local time, locale, time format, and time-zone propagation.
- [x] Complete reminder action tools and their private UI controls.
- [ ] Run one harmless production acceptance test for each domain.
- [x] Add a strict offline agent and retrieval evaluation gate to the root check.
- [x] Add cross-service traces and content-free operational alerts.
- [x] Apply deterministic English and Swedish safety, intent, and output rules.

### P1: Make recall useful

- [ ] Populate confirmed memory with owner-reviewed records.
- [x] Add task-specific context for reminders and training.
- [x] Measure lexical retrieval with a synthetic, invented-data corpus.
- [ ] Add embeddings and reranking only after the lexical baseline exists.
- [x] Add journal, training, reminder, and memory owner workflows to the private UI.
- [ ] Add guided first-use onboarding for these workflows.

### P2: Improve operations

- [x] Implement a four-hour encrypted backup job with 42-copy retention.
- [ ] Copy encrypted archives to node-independent storage outside Cloudflare.
- [x] Implement an isolated EU restore drill with full table-content hash checks.
- [x] Run and record a primary-data restore drill.
- [x] Define latency and availability SLOs.
- [x] Track tokens and quota by feature and workflow.
- [x] Send redacted Bob agent logs to Loki and add a production Grafana dashboard.
- [x] Add a fail-open native OTLP exporter for agent spans.
- [x] Add reusable, content-free Effect telemetry Layers for Node and Workers.
- [x] Trace the Pi loop, model turns, Tool calls, validation, repair, reminders, and Sendblue delivery.
- [ ] Release the agent exporter and verify one real end-to-end Tempo trace.
- [ ] Export Cloudflare Worker logs and traces through authenticated OTLP destinations.
- [ ] Add an owner-only durable run timeline with explicit content reveal and audit records.
- [ ] Add model fallback only after measured failure data justifies it.

## Deferred items

Do not add these while Bob uses OpenAI-hosted inference:

- KV-cache management.
- Prefill and decode optimization.
- Continuous batching.
- Paged attention.
- Speculative decoding.
- Quantization format selection.

## Evidence locations

- Agent loop and guardrails: [`packages/pi-agent/src/index.ts`](../packages/pi-agent/src/index.ts)
- Tool schemas: [`packages/contracts/src/tools.ts`](../packages/contracts/src/tools.ts)
- Durable inbound processing: [`apps/core-worker/src/process-inbound.ts`](../apps/core-worker/src/process-inbound.ts)
- Context selection: [`apps/core-worker/src/modules/context/store.ts`](../apps/core-worker/src/modules/context/store.ts)
- Retrieval rules: [`apps/core-worker/src/modules/memory/retrieval.ts`](../apps/core-worker/src/modules/memory/retrieval.ts)
- Memory retrieval: [`apps/core-worker/src/modules/memory/store.ts`](../apps/core-worker/src/modules/memory/store.ts)
- Tool execution: [`apps/core-worker/src/modules/conversations/tool-executor.ts`](../apps/core-worker/src/modules/conversations/tool-executor.ts)
- Assistant response safety: [`packages/pi-agent/src/response-safety.ts`](../packages/pi-agent/src/response-safety.ts)
- Effect trace contract: [`packages/observability/src/effect.ts`](../packages/observability/src/effect.ts)
- OTLP transport: [`packages/observability/src/otlp.ts`](../packages/observability/src/otlp.ts)
- Telemetry decision: [`docs/adr/0008-effect-telemetry-and-trace-contract.md`](adr/0008-effect-telemetry-and-trace-contract.md)
- Token attribution: [`apps/core-worker/src/modules/observability/store.ts`](../apps/core-worker/src/modules/observability/store.ts)
- Agent evaluation gate: [`tools/agent-evals/src/gate.ts`](../tools/agent-evals/src/gate.ts)
- Owner workflow tests: [`apps/core-worker/test-workers/owner-workflows.test.ts`](../apps/core-worker/test-workers/owner-workflows.test.ts)
- Private UI: [`apps/ui/src/main.ts`](../apps/ui/src/main.ts)
- Backup archive: [`tools/data-backup/src/archive.ts`](../tools/data-backup/src/archive.ts)
- Backup source: [`tools/data-backup/src/cloudflare.ts`](../tools/data-backup/src/cloudflare.ts)
- Restore drill: [`tools/data-backup/src/restore.ts`](../tools/data-backup/src/restore.ts)
- Cache policy: [`docs/adr/0006-personal-context-cache-policy.md`](adr/0006-personal-context-cache-policy.md)
- Backup schedule: [`infra/kubernetes/base/backup-job.yaml`](../infra/kubernetes/base/backup-job.yaml)
- Backup runbook: [`docs/runbooks/backup-restore.md`](runbooks/backup-restore.md)

## Update procedure

1. Update the date and repository baseline.
2. Add links to tests, production queries, traces, or runbook evidence.
3. Change a status only when its stated proof is complete.
4. Keep implementation status separate from production proof.
5. Add new work to the priority backlog before implementation.
6. Review this checklist after each production release.
