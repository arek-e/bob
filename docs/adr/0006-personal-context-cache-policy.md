# ADR 0006: Personal context cache policy

- Status: Accepted

- Date: 2026-08-11

## Decision

Bob does not cache model responses.

Personal facts, journal records, reminders, training state, and tool results can change between turns.

A stale response can cause more harm than the saved latency can justify.

Deterministic commands can bypass the model. They do not need a response cache.

## Required evidence

Record these values before adding a Bob-owned cache:

- The number of repeated read-only requests.
- The model latency for those requests.
- The token use that a cache could avoid.
- The stale-answer rate in an invented-data replay set.

Do not add a cache when the eligible request rate is low.

## Reconsideration contract

A future cache can store read-only model results only.

The cache key must include these values:

- Owner ID.
- Model, prompt, tool-set, and response-schema versions.
- Locale, time zone, and a bounded time bucket.
- Confirmed fact revision IDs.
- Selected reminder, routine, workout, and journal-summary revision IDs.
- The normalized user request.

Never share a cache entry between owners.

Never cache a mutation, urgent-safety response, disputed fact, raw journal record, or untrusted document.

Encrypt each stored value with the owner data key.

Use a short expiry. Invalidate the entry after each confirmed fact or task-state change.

Treat a cache miss as normal. Do not let a cache failure stop a request.

## Consequences

Bob uses more model tokens for repeated requests today.

Bob avoids a hidden source of stale personal advice.

This decision does not control OpenAI provider-side inference caches.
