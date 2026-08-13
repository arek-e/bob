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

## Roll back before the Core deployment

Use this path when the new agent fails while the old Core remains live.

Keep Sendblue traffic paused. Do not deploy the Cloudflare plan.

Restore the prior Runtime SHA. This also restores the prior agent digest.

```sh
docker compose -f infra/coolify/compose.yaml up -d agent
docker compose -f infra/coolify/compose.yaml ps agent
docker compose -f infra/coolify/compose.yaml exec agent \
  node --input-type=module -e 'const r = await fetch("http://127.0.0.1:8787/health"); if (!r.ok) process.exit(1)'
docker compose -f infra/coolify/compose.yaml ps agent

CURRENT_AGENT_IMAGE="$(docker compose -f infra/coolify/compose.yaml images -q agent)"
test "$CURRENT_AGENT_IMAGE" = "$PRIOR_AGENT_IMAGE"
```

Repeat the stable Core, agent health, and agent-to-Core checks.

Resume traffic only after all checks pass.

Do not reverse an additive D1 migration. A migration can exist before its code uses it.

## Roll back after the Core deployment

Use this path when the reviewed Cloudflare deployment has started or completed.

Pause provider traffic. Reconcile each active or unknown action before rollback.

Do not deploy an old infrastructure tree without review. It can remove required Access resources.

Create a rollback commit from the current release. Restore only the prior Core Worker code.

Keep the stable `bob.<domain>` host, current Access resources, retained data, and current migrations.

Run a new production plan. Reject any D1, R2, Queue, or retained-resource deletion.

```sh
pnpm infra:plan
docker compose -f infra/coolify/compose.yaml config --quiet
```

Never roll back additive D1 migrations. The prior Core must tolerate the expanded schema.

Verify the stable Core `/health` and `/setup` paths with the new compatible agent.

Wait for the External Secrets refresh. Force and verify the agent restart.

Then restore the prior Runtime SHA and prior agent digest.

```sh
docker compose -f infra/coolify/compose.yaml up -d agent
docker compose -f infra/coolify/compose.yaml ps agent
docker compose -f infra/coolify/compose.yaml exec agent \
  node --input-type=module -e 'const r = await fetch("http://127.0.0.1:8787/health"); if (!r.ok) process.exit(1)'
docker compose -f infra/coolify/compose.yaml ps agent

CURRENT_AGENT_IMAGE="$(docker compose -f infra/coolify/compose.yaml images -q agent)"
test "$CURRENT_AGENT_IMAGE" = "$PRIOR_AGENT_IMAGE"
```

Repeat the stable Core, agent health, and agent-to-Core checks.

Resume traffic and domain tools only after every check passes.

## Review

Record the cause, affected opaque identifiers, duration, and corrective control.

Do not include messages, phone numbers, credentials, prompts, or journal text.
