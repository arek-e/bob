# Deployment runbook

## Preconditions

Complete every production gate in the project plan.

Approve the Alchemy state privacy review before a production plan.

Create the scoped OpenBao identity. Do not use a Cloudflare administrator token.

Build and publish the agent image by digest.

Use a reviewed cloudflared digest.

Update the two immutable images in `infra/kubernetes/overlays/prod`.

Do not replace either digest with a mutable tag.

Use Cilium for Bob egress enforcement.

Allow direct CoreDNS queries and public IPv4 HTTPS only.

Exclude private and reserved IPv4 ranges.

Do not use Cilium DNS proxy rules for Bob. The current transparent proxy drops Bob DNS requests.

Repair the proxy through cluster GitOps before you restore FQDN rules.

Use the in-cluster OpenBao service for runtime secret access.

Confirm `kubectl kustomize infra/kubernetes` contains no unresolved input.

Create `ops/apps/prod/bob/config` before planning.

Keep the persistent deployment fields in that record. Do not commit their values.

Create the other scoped OpenBao records before secret synchronization.

Install the reviewed External Secrets controller.

Create the `bob-agent` OpenBao Kubernetes role for Pi OAuth only.

Confirm the role accepts only the `bob-agent` ServiceAccount in the `bob` namespace.

Create the `bob-agent-secret-delivery` OpenBao Kubernetes role.

Attach the production secret-delivery policy to that role.

Confirm it accepts only the matching secret-delivery ServiceAccount.

Create one read-only GitHub deploy key for the Bob repository.

Store its private key at `ops/apps/prod/bob/argocd/repository`.

Never apply a raw repository Secret with `kubectl`.

Apply `argocd-repository-production-policy.hcl` to OpenBao.

Create the `bob-argocd-repository` Kubernetes role in OpenBao.

Bind it only to `argocd/bob-argocd-repository` with audience `openbao`.

## Validate

Run these commands from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm secrets:scan:staged
```

Run the complete secret scan only with the trusted OpenBao identity.

```sh
pnpm secrets:scan:trusted
node scripts/verify-deployment-readiness.mjs
kubectl kustomize infra/kubernetes >/dev/null
kubectl kustomize infra/argocd >/dev/null
```

Do not continue when the trusted scan or deployment check fails.

## Plan Cloudflare changes

Set only declared Varlock inputs. Then run this command.

```sh
pnpm infra:plan
```

Review every replacement. Stop when any replacement lacks written approval.

Run `pnpm infra:load` before the plan.

The infrastructure workspace uses the reviewed Effect beta.102 exception.
Application workspaces use beta.107.

The trusted CI plan is a release gate.
Do not deploy when the plan job is skipped or fails.

GitHub OIDC requires a runner with network access to OpenBao.

For a local handoff, mint one 10-minute orphan token.

Attach only the `bob-deployment-credential-handoff` policy.

Create this token role once:

```sh
bao write auth/token/roles/bob-deployment-handoff \
  allowed_policies=bob-deployment-credential-handoff \
  orphan=true \
  token_explicit_max_ttl=10m
```

Mint the token through that role. The policy permits only four runtime writes and self-revocation.

```sh
bao token create \
  -role=bob-deployment-handoff \
  -policy=bob-deployment-credential-handoff \
  -ttl=10m
```

Enter it through the hidden `BAO_DEPLOY_TOKEN` environment input.

Do not use GitHub OIDC fields at the same time.

The handoff revokes the token after its four writes. Unset the input after the command.

## Release preflight

Use the stable Core host for every check and deployment.

```sh
CORE_URL="https://bob.${BOB_DOMAIN}"
node --input-type=module -e '
  const url = new URL(process.argv[1])
  if (url.protocol !== "https:" || !url.hostname.startsWith("bob.") || url.pathname !== "/") {
    process.exit(1)
  }
' "$CORE_URL"
curl -fsS "$CORE_URL/health" >/dev/null
SETUP_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "$CORE_URL/setup")"
case "$SETUP_STATUS" in 200|302|401|403) ;; *) exit 1 ;; esac
```

Do not use a `workers.dev` address as `CORE_URL`.

Test the current agent-to-Core Access path. The request must reach Core and fail schema validation.

```sh
kubectl --context=teampitch-prod -n bob exec deployment/bob-agent -c agent -- \
  env EXPECTED_CORE_URL="$CORE_URL" node --input-type=module -e '
    if (process.env.CORE_URL !== process.env.EXPECTED_CORE_URL) process.exit(1)
    const response = await fetch(`${process.env.CORE_URL}/internal/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Access-Client-Id": process.env.CORE_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": process.env.CORE_ACCESS_CLIENT_SECRET
      },
      body: "{}"
    })
    const body = await response.json()
    if (response.status !== 400 || body.code !== "invalid_request") process.exit(1)
  '
```

Stop if `/health`, `/setup`, or the internal Access check fails.

Record the live rollback values before any change.

```sh
PRIOR_ARGO_SHA="$(kubectl --context=teampitch-prod -n argocd \
  get application bob -o jsonpath='{.spec.source.targetRevision}')"
PRIOR_AGENT_IMAGE="$(kubectl --context=teampitch-prod -n bob \
  get deployment bob-agent -o jsonpath='{.spec.template.spec.containers[?(@.name=="agent")].image}')"
```

Keep these values in the operator record. They do not contain credentials.

Use a quiet owner window. Pause Sendblue traffic before the Core drain gate.

## Production cutover

Follow these steps in order. Do not combine the agent and Core deployments.

### 1. Publish attested images from the release SHA

The release SHA must be a full commit on `main`.

```sh
RELEASE_SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
gh workflow run release-images.yml --ref main -f release_sha="$RELEASE_SHA"
```

The workflow checks out that exact SHA. It publishes the agent and backup images.

The workflow also creates provenance attestations and software bills of materials.

Copy both digests from the workflow summary. Verify both attestations.

```sh
gh attestation verify "oci://ghcr.io/arek-e/bob-agent@${AGENT_DIGEST}" --repo arek-e/bob
gh attestation verify "oci://ghcr.io/arek-e/bob-data-backup@${BACKUP_DIGEST}" --repo arek-e/bob
```

Pin both digests in `infra/kubernetes/overlays/prod/kustomization.yaml`.

Create and push a reviewed GitOps commit with those pins. Do not change runtime files in that commit.

```sh
GITOPS_SHA="$(git rev-parse HEAD)"
git diff --exit-code "$RELEASE_SHA" "$GITOPS_SHA" -- apps packages tools
node scripts/verify-deployment-readiness.mjs
```

### 2. Deploy the compatible agent while the old Core stays live

The new agent must accept the old Core request contract. Verify the compatibility test first.

```sh
pnpm exec vitest run packages/contracts/test/agent.test.ts packages/pi-agent/test/tools.test.ts
```

Do not run the Cloudflare deployment in this step.

Bootstrap the isolated Argo repository identity when this is the first deployment.

```sh
kubectl --context=teampitch-prod apply --server-side \
  -f infra/argocd/namespace.yaml \
  -f infra/argocd/repository-service-account.yaml \
  -f infra/argocd/repository-secret-store.yaml

kubectl --context=teampitch-prod -n argocd wait \
  --for=condition=Ready secretstore/bob-argocd-repository \
  --timeout=2m

kubectl --context=teampitch-prod apply --server-side \
  -f infra/argocd/repository-external-secret.yaml

kubectl --context=teampitch-prod -n argocd wait \
  --for=condition=Ready externalsecret/bob-repository \
  --timeout=2m
```

Apply the scoped project and application. Set the live Argo target to the reviewed GitOps SHA.

```sh
kubectl --context=teampitch-prod apply --server-side -f infra/argocd/project.yaml
kubectl --context=teampitch-prod apply --server-side -f infra/argocd/application.yaml
kubectl --context=teampitch-prod -n argocd patch application bob --type=merge \
  --patch "{\"spec\":{\"source\":{\"targetRevision\":\"$GITOPS_SHA\"}}}"

kubectl --context=teampitch-prod -n argocd wait \
  --for=jsonpath='{.status.sync.status}'=Synced application/bob --timeout=10m
kubectl --context=teampitch-prod -n argocd wait \
  --for=jsonpath='{.status.health.status}'=Healthy application/bob --timeout=10m
kubectl --context=teampitch-prod -n bob rollout status deployment/bob-agent --timeout=10m
```

Record the same reviewed target in `infra/argocd/application.yaml` after the cutover.

### 3. Verify the new agent against the old Core

Confirm the deployed image matches the attested agent digest.

```sh
DEPLOYED_AGENT_IMAGE="$(kubectl --context=teampitch-prod -n bob \
  get deployment bob-agent -o jsonpath='{.spec.template.spec.containers[?(@.name=="agent")].image}')"
test "$DEPLOYED_AGENT_IMAGE" = "ghcr.io/arek-e/bob-agent@${AGENT_DIGEST}"
kubectl --context=teampitch-prod -n bob exec deployment/bob-agent -c agent -- \
  node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:8787/health")
    if (!response.ok) process.exit(1)
  '
```

Repeat the agent-to-Core Access check from the release preflight.

Check the Core `/health` and `/setup` paths again. The old Core must remain live.

Use the pre-Core rollback procedure when any check fails.

### 4. Drain runs and deploy the reviewed Cloudflare plan

Keep Sendblue traffic paused. Wait for the old agent pod to terminate.

Query production D1 immediately before the Cloudflare deployment.

```sh
DRAIN_SQL="SELECT \
  (SELECT COUNT(*) FROM agent_runs WHERE status IN ('pending','claimed','executing')) AS active_runs, \
  (SELECT COUNT(*) FROM tool_calls WHERE status IN ('pending','claimed','executing')) AS active_tool_calls"
DRAIN_JSON="$(pnpm --filter @bob/cloudflare-infra exec wrangler d1 execute bob-prod \
  --remote --json --command "$DRAIN_SQL")"
printf '%s' "$DRAIN_JSON" | jq -e \
  '.[0].results[0] | .active_runs == 0 and .active_tool_calls == 0' >/dev/null
```

Stop when either count is not zero. Reconcile the active action before another check.

The gate prevents an old result from reaching the new Core contract.

Apply only the reviewed production plan. Use the same GitOps commit that produced the plan.

```sh
test "$(git rev-parse HEAD)" = "$GITOPS_SHA"
git diff --quiet
pnpm infra:plan
pnpm --filter @bob/cloudflare-infra deploy
```

Keep the stable `https://bob.${BOB_DOMAIN}` host. Do not cut traffic to another Core address.

Verify D1 and R2 report EU jurisdiction. Verify every Queue and dead letter Queue.

Verify Better Auth protects each owner API route.

Verify Access protects only the Core `/internal` and `/setup` paths.

Verify Access still protects the agent host. Verify the ingress host remains public.

Enable the reviewed credential handoff only in trusted GitHub Actions.

Write the Access records and Tunnel token directly to OpenBao.

Do not store these values in workflow artifacts or command output.

Never reverse an additive D1 migration during deployment or rollback.

### 5. Wait for the External Secrets refresh

Record the current refresh time. Then request one immediate refresh.

```sh
PRIOR_REFRESH_TIME="$(kubectl --context=teampitch-prod -n bob \
  get externalsecret bob-agent-bootstrap -o jsonpath='{.status.refreshTime}')"
ESO_REQUESTED_AT="$(date +%s)"
kubectl --context=teampitch-prod -n bob annotate externalsecret bob-agent-bootstrap \
  force-sync="$ESO_REQUESTED_AT" --overwrite

for _ in {1..36}; do
  CURRENT_REFRESH_TIME="$(kubectl --context=teampitch-prod -n bob \
    get externalsecret bob-agent-bootstrap -o jsonpath='{.status.refreshTime}')"
  test "$CURRENT_REFRESH_TIME" != "$PRIOR_REFRESH_TIME" && break
  sleep 5
done
test "$CURRENT_REFRESH_TIME" != "$PRIOR_REFRESH_TIME"
kubectl --context=teampitch-prod -n bob wait \
  --for=condition=Ready externalsecret/bob-agent-bootstrap --timeout=2m
```

Confirm the synchronized Secret contains every required key. Never print its data.

Stop when the secret workflow or scoped OpenBao role is absent.

### 6. Force and verify an agent restart

The running pod does not reload synchronized environment values.

```sh
PRIOR_AGENT_POD_UID="$(kubectl --context=teampitch-prod -n bob \
  get pod -l app.kubernetes.io/name=bob-agent -o jsonpath='{.items[0].metadata.uid}')"
kubectl --context=teampitch-prod -n bob rollout restart deployment/bob-agent
kubectl --context=teampitch-prod -n bob rollout status deployment/bob-agent --timeout=10m
CURRENT_AGENT_POD_UID="$(kubectl --context=teampitch-prod -n bob \
  get pod -l app.kubernetes.io/name=bob-agent -o jsonpath='{.items[0].metadata.uid}')"
test "$CURRENT_AGENT_POD_UID" != "$PRIOR_AGENT_POD_UID"
```

Verify the image digest again. Repeat the agent health and internal Access checks.

Use the post-Core rollback procedure when any check fails.

### 7. Accept traffic and test domain tools

Resume Sendblue only after every prior gate passes.

Run the Sendblue reconciler after the ingress URL is stable.

Use a known harmless outbound message handle for the delivery-status proof.

```sh
pnpm sendblue:reconcile -- --check --message-handle <message-handle>
pnpm sendblue:reconcile -- --message-handle <message-handle>
```

Continue only when the command reports `readyForPing: true`.

Ask the allowlisted owner to send `PING`. Confirm one generic response.

Run one harmless round trip. Then verify duplicate and timeout states in D1.

Test read-only domain tools first. Test one reversible write only after those checks pass.

For the first Better Auth release, open the stable Core `/setup` path.

Complete the Cloudflare Access check. Create the owner password once.

Confirm `/settings` opens with the new session. Then sign out and sign in again.

The setup API rejects another account after the owner record exists.

Access service tokens expire after seven days.

Increment `ACCESS_SERVICE_TOKEN_ROTATION_VERSION` for each rotation.

Set `ACCESS_SERVICE_TOKEN_ROTATE_BY` between 24 hours and eight days ahead.

Rotate and sync all three service tokens before that deadline.

Never print a service secret or Tunnel token. Store only runtime copies in OpenBao.

The generic base uses invalid image sentinels and unresolved host inputs.

Only the production overlay is deployable.

The root Kustomization renders that overlay.

The readiness check rejects unresolved, mutable, or local-only images.

External Secrets synchronizes live credentials from OpenBao.

## Production safety

Production D1, R2, and Queues use retain policies.

Never run `alchemy unsafe nuke` for Bob.

Do not remove retained resources to simulate a reset.
