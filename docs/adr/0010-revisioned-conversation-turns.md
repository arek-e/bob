# ADR 0010: Use revisioned conversation turns for message steering

- Status: Accepted
- Date: 2026-08-12
- Scope: Sendblue conversation collection, agent runs, and recent context
- Amends: ADR 0003

## Context

People often send one request as several short messages.

Bob previously started one agent run for each message.

This caused replies that ignored a later correction or continuation.

An in-memory abort signal cannot make this workflow durable.

It also cannot undo an external action that already started.

Bob needs one durable response target and a safe delivery boundary.

Bob also needs limited recent context after a delivered reply.

That context must not weaken the journal privacy rule.

## Decision

Add one durable conversation turn above immutable agent runs.

Each turn belongs to one owner and one channel.

Each accepted inbound message increases the turn revision.

The latest message in the current revision is the response target.

Use a 1.5-second trailing collection window.

Limit one collection burst to five seconds.

An agent run takes one immutable snapshot of one turn revision.

Do not change a run input after the run starts.

A later message supersedes the old run revision.

Abort an obsolete model call when possible.

Do not treat abort as rollback.

Let an external action that already started reach a durable result.

Then reflect again with the new message and that result.

Use one opaque mutation identity for the same semantic action across turn revisions.

Do not include private arguments or source-message evidence in that identity.

Load prior terminal tool results as bounded private context for the next revision.

Do not load prior tool arguments, call IDs, idempotency keys, or model drafts.

Apply the same run and reply fences to deterministic actions and replies.

Only the current turn revision can commit a reply outbox.

Delivery claims must check the turn revision and reply outbox identity.

A stale reply becomes cancelled before provider delivery.

The successful delivery claim closes the matching turn as replied.

If a newer revision wins after delivery claim, keep that revision open.

The provider send can no longer be withdrawn at that point.

Bob must send one contextual follow-up for the newer revision.

### Recent conversation context

The context store can load recent conversation data only when it receives a current turn ID.

Load prior replied turns for the same owner and channel only.

Require a confirmed delivered attempt for each recalled reply.

Exclude the current turn, drafts, failed sends, and uncertain sends.

Use only turns delivered during the prior 15 minutes.

Load at most four prior turn pairs.

Load at most six messages and 2,400 characters.

Prefer the newest eligible messages when a limit applies.

Decrypt selected messages only during context-pack assembly.

Mark each item as untrusted conversation data with `instruction: false`.

Attach the source message IDs.

Do not put message text in logs, traces, or metrics.

Conservatively exclude a complete turn when its messages show journal intent.

Do not load raw journal text or journal summaries.

Calls without a current turn ID keep the old context behavior.

### Short follow-up tool selection

Do not use recalled message text to expand the tool set.

For a short list follow-up, load one capability hint from the newest delivered turn.

Derive the hint from the completed run and tool name for that exact turn revision.

Allow only reviewed read-only capabilities. The first release allows `reminder_list`.

Do not infer mutation or journal capabilities.

Do not skip across a newer unrelated delivered turn.

The latest explicit intent or retraction overrides the hint.

## Consequences

Bob can treat a burst of short messages as one response target.

Later corrections supersede stale model output.

Durable revision checks work after Worker or Durable Object restarts.

Already-started external actions remain explicit and idempotent.

Recent delivered messages support natural follow-up requests.

The fixed limits reduce prompt growth and private-data exposure.

The design adds turn, revision, and delivery-fence records to D1.

The application must test races at run, tool, reply, and delivery boundaries.

## Verification

1. Two messages in one burst produce one latest response target.
2. A later message supersedes an obsolete run revision.
3. A stale run cannot commit or deliver a reply.
4. A claimed external action is not repeated after steering.
5. A delivery claim closes only its exact current turn revision.
6. A newer revision after delivery claim stays open for follow-up.
7. Recent context uses only delivered prior same-channel turns.
8. Recent context excludes the current turn and journal-intent turns.
9. Recent context stays within all time, turn, message, and character limits.
10. Logs and traces contain no message content.
11. An identical mutation across revisions returns one prior durable result.
12. Reflection context contains tool results but no prior private tool arguments.
13. A short follow-up can reuse only the latest delivered safe read capability.
14. Recalled text, mutations, and journal metadata cannot expand the follow-up tool set.
