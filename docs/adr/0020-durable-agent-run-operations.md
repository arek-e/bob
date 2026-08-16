# ADR 0020: Checkpoint completed Agent run operations

- Status: Accepted
- Date: 2026-08-16
- Scope: Agent run durability, replay, and Plan artifacts
- Amends: ADR 0003 and ADR 0010

## Context

Bob stores immutable Agent run input, attempts, Tool calls, final responses, and delivery work.

The Bob Pi loop keeps its model context and loop position in process memory.

A process failure can therefore repeat completed model work. It can also lose the exact position
between completed Tool calls.

Tool idempotency prevents many repeated mutations. It does not restore the model context that led to
the Tool call.

Plan artifact items are owner-facing text. They do not have stable execution identity, inputs, retry
rules, or completion evidence.

Durable agent runtimes checkpoint completed graph or workflow operations. They restore completed
outputs and continue from the first incomplete operation.

## Decision

Add one append-only Agent run operation log to the General Agent Core.

The core Worker owns the log. The Agent host remains stateless.

The fixed, admin-only operational model smoke is not an Agent run.

It accepts no owner data or Tools and does not use the Agent run operation log.

Checkpoint these completed Agent run operations:

1. Each successful model response.
2. Each terminal Tool result.
3. Each validated final Agent run result.

Store the operation before the Pi loop starts the next operation.

Bound each Tool result so one operation fits in the checkpoint request. Replace an oversized result
with a bounded result. Preserve confirmed, proposed, or unknown mutation evidence in that result.

Assign each operation one monotonic sequence number within its Agent run.

Fence every append with the current Agent run attempt ID. A stale attempt cannot append.

Make an identical append for an existing sequence idempotent. Reject different content for the same
sequence.

Encrypt every operation payload with the owner's data key.

Store no model reasoning, credentials, or plaintext private content in the operation log, traces, or
metrics.

Include one explicit loop version in each operation. Reject unsupported versions during resume.

On retry, rebuild the Pi model context from the immutable Agent run input and the ordered operation
log. Restore usage counters, Tool evidence, and the next incomplete Tool call.

Treat provider, timeout, and checkpoint availability failures as retryable when no mutation needs
recovery. Release the attempt and the current conversation revision in one D1 batch. Retry the same
run from its operation log after 30 seconds. Stop after three Agent run attempts and return the normal
bounded failure response.

Keep authentication, quota, policy, invalid output, and owner steering results terminal. Let mutation
recovery take priority over Agent run retry.

Do not repeat a checkpointed model call.

The Tool Executor remains authoritative for Tool idempotency and external action outcomes. A replayed
Tool result does not bypass Tool policy.

Keep `unknown` as the terminal result for an external action that can have completed without a stored
provider result. Do not retry it before reconciliation.

Keep the final response, Plan artifact revision, Agent run completion, and delivery outbox in the
existing fenced core Worker batch.

A Plan artifact remains a structured draft. Its items are not Agent run operations or executable
workflow steps.

Add a Workflow Module only when Bob has a real long-running workflow. Each executable workflow step
must then have a stable ID, explicit state, retry rules, and completion evidence.

## Consequences

Bob can continue an Agent run after an Agent host or network failure.

Completed model calls and Tool calls do not need to run again.

The operation log adds encrypted storage proportional to bounded Agent run work.

Replay depends on stable operation ordering and loop-version compatibility.

The Agent host needs a narrow core Worker Interface to load and append operations.

Plan artifacts stay independent from workflow execution state.

## Verification

1. A crash after a model checkpoint does not repeat that model call.
2. A crash after a Tool checkpoint restores its result.
3. A run with multiple Tool calls resumes at the first incomplete Tool call.
4. A stale attempt cannot append an operation.
5. An identical append is idempotent.
6. Different content for one sequence is rejected.
7. A superseded turn cannot resume and deliver a reply.
8. An `unknown` mutation does not run again without reconciliation.
9. An unsupported loop version fails before model or Tool execution.
10. Operation payloads are encrypted at rest.
11. Logs and traces contain no operation payload content.
12. A checkpointed final result returns without another model call.
13. A transient Agent host failure retries the same run without a terminal reply.
14. Retry exhaustion produces one terminal failure response.
15. An oversized read result becomes a bounded failure that can checkpoint.
16. An oversized mutation result keeps its action outcome evidence.
