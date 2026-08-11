# Sendblue runbook

## Reconcile webhooks

Confirm the ingress URL and shared secret. Use the trusted production identity.

Run `pnpm sendblue:reconcile -- --check` first. Review the additions.

Run `pnpm sendblue:reconcile` to add missing receive and outbound hooks.

The tool preserves unrelated hooks. It stops when the global secret differs.

## Test

Send harmless text from the allowed number. Confirm one inbound D1 record.

Replay the webhook. Confirm Bob creates no second agent run.

Test an outbound timeout. Confirm the attempt becomes `uncertain`.

Do not retry an uncertain send automatically.

Test `STOP`, `START`, `CANCEL`, and provider `opted_out` events.

## Owner recovery

If the owner opted out, stop every outbound message.

Tell the owner to send `START` to the Bob number.

Do not claim that delivery means acknowledgment or completion.
