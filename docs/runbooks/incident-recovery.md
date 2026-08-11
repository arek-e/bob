# Incident recovery runbook

## Contain

Pause Sendblue egress for a delivery incident. Keep accepted inbound records durable.

Stop agent runs for an authentication, quota, or model-policy incident.

Revoke only the affected service token. Do not rotate unrelated credentials.

## Investigate

Use correlation identifiers and content-free events. Do not copy private text into a ticket.

Classify external actions as completed, failed, or unknown.

Reconcile every unknown action before retrying it.

## Recover

Run duplicate, timeout, and privacy tests with offline fixtures.

Review the production plan. Deploy only the reviewed fix.

Resume one agent replica. Resume egress after provider reconciliation.

Notify the owner with short factual text when the incident affected reminders.

## Review

Record the cause, affected opaque identifiers, duration, and corrective control.

Do not include messages, phone numbers, credentials, prompts, or journal text.
