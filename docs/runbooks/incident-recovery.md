# Incident recovery runbook

## Contain

Pause Sendblue egress for a delivery incident. Keep accepted inbound records durable.

Stop agent runs for an authentication, quota, or model-policy incident.

Revoke only the affected service token. Do not rotate unrelated credentials.

## Investigate

Use correlation identifiers and content-free events. Do not copy private text into a ticket.

Classify external actions as completed, failed, or unknown.

Reconcile every unknown action before retrying it.

For a missing inbound message, check each boundary in this order:

1. Check Sendblue message history.
2. Check Cloudflare for a POST to the receive webhook.
3. Check D1 for durable acceptance.
4. Check Tempo and Loki with the correlation identifier.

If Sendblue history has no message, classify the failure as external provider acceptance.

If Sendblue history has a message but D1 does not, check the scheduled history reconciliation.

## Recover

Run duplicate, timeout, and privacy tests with offline fixtures.

Review the production plan. Deploy only the reviewed fix.

Resume one agent replica. Resume egress after provider reconciliation.

Notify the owner with short factual text when the incident affected reminders.

## Roll back before the Core deployment

Use this path when the new agent fails while the old Core remains live.

Keep Sendblue traffic paused. Do not deploy the Cloudflare plan.

Restore the prior Argo SHA. This also restores the prior agent digest.

```sh
kubectl --context=teampitch-prod -n argocd patch application bob --type=merge \
  --patch "{\"spec\":{\"source\":{\"targetRevision\":\"$PRIOR_ARGO_SHA\"}}}"
kubectl --context=teampitch-prod -n argocd wait \
  --for=jsonpath='{.status.sync.status}'=Synced application/bob --timeout=10m
kubectl --context=teampitch-prod -n argocd wait \
  --for=jsonpath='{.status.health.status}'=Healthy application/bob --timeout=10m
kubectl --context=teampitch-prod -n bob rollout status deployment/bob-agent --timeout=10m

CURRENT_AGENT_IMAGE="$(kubectl --context=teampitch-prod -n bob \
  get deployment bob-agent -o jsonpath='{.spec.template.spec.containers[?(@.name=="agent")].image}')"
test "$CURRENT_AGENT_IMAGE" = "$PRIOR_AGENT_IMAGE"
```

Repeat the stable Core, agent health, and agent-to-Core checks.

Resume traffic only after all checks pass.

Do not reverse an additive D1 migration. A migration can exist before its code uses it.

## Roll back after the Core deployment

Use this path when the reviewed Cloudflare deployment has started or completed.

Pause Sendblue traffic. Reconcile each active or unknown action before rollback.

Use the Worker names and version identifiers from the preflight operator record.

Restore the failed release source SHA from the operator record.

```sh
: "${BOB_RELEASE_SHA:?Restore the failed release source SHA}"
[[ "$BOB_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]
export BOB_RELEASE_SHA
```

Restore egress before ingress. The new ingress accepts the prior callback format.

Then restore ingress. Restore Core last because both channel Workers depend on its stable interface.

```sh
pnpm --filter @bob/cloudflare-infra exec varlock run --inject all --skip-cache -- \
  wrangler versions deploy \
  "$PRIOR_EGRESS_VERSION_ID@100" --name "$EGRESS_WORKER_NAME" --yes
pnpm --filter @bob/cloudflare-infra exec varlock run --inject all --skip-cache -- \
  wrangler versions deploy \
  "$PRIOR_INGRESS_VERSION_ID@100" --name "$INGRESS_WORKER_NAME" --yes
pnpm --filter @bob/cloudflare-infra exec varlock run --inject all --skip-cache -- \
  wrangler versions deploy \
  "$PRIOR_CORE_VERSION_ID@100" --name "$CORE_WORKER_NAME" --yes
```

These commands create new deployments. They do not delete retained resources.

Keep the stable `bob.<domain>` host, current Access resources, retained data, and current migrations.

Never roll back additive D1 migrations. The prior Core must tolerate the expanded schema.

Verify the stable Core `/health` and `/setup` paths with the new compatible agent.

Wait for the External Secrets refresh. Force and verify the agent restart.

Then restore the prior Argo SHA and prior agent digest.

```sh
kubectl --context=teampitch-prod -n argocd patch application bob --type=merge \
  --patch "{\"spec\":{\"source\":{\"targetRevision\":\"$PRIOR_ARGO_SHA\"}}}"
kubectl --context=teampitch-prod -n argocd wait \
  --for=jsonpath='{.status.sync.status}'=Synced application/bob --timeout=10m
kubectl --context=teampitch-prod -n argocd wait \
  --for=jsonpath='{.status.health.status}'=Healthy application/bob --timeout=10m
kubectl --context=teampitch-prod -n bob rollout status deployment/bob-agent --timeout=10m

CURRENT_AGENT_IMAGE="$(kubectl --context=teampitch-prod -n bob \
  get deployment bob-agent -o jsonpath='{.spec.template.spec.containers[?(@.name=="agent")].image}')"
test "$CURRENT_AGENT_IMAGE" = "$PRIOR_AGENT_IMAGE"
```

Repeat the stable Core, agent health, and agent-to-Core checks.

Resume traffic and domain tools only after every check passes.

## Review

Record the cause, affected opaque identifiers, duration, and corrective control.

Do not include messages, phone numbers, credentials, prompts, or journal text.
