# Deployment runbook

## Preconditions

Complete every production gate in the project plan.

Approve the Alchemy state privacy review before a production plan.

Create the scoped OpenBao identity. Do not use a Cloudflare administrator token.

Build and publish the agent image by digest.

Use a reviewed cloudflared digest.

Set both image repositories and both `sha256` digest inputs.

Do not replace the digest inputs with mutable tags.

Install Cilium with FQDN policy support. Review the two permitted external hosts.

Set `BOB_CORE_FQDN` and `OPENBAO_FQDN` to those reviewed hosts.

Set `CILIUM_FQDN_POLICY_APPROVED=true` only after the cluster enforces the policy.

Render both FQDN tokens before you apply the Kubernetes manifests.

Create `ops/apps/prod/bob/config` before planning.

Keep the persistent deployment fields in that record. Do not commit their values.

Create the other scoped OpenBao records before secret synchronization.

Install the reviewed External Secrets controller.

Create the `bob-agent` OpenBao Kubernetes role for Pi OAuth only.

Confirm the role accepts only the `bob-agent` ServiceAccount in the `bob` namespace.

Create the `bob-agent-secret-delivery` OpenBao Kubernetes role.

Attach the production secret-delivery policy to that role.

Confirm it accepts only the matching secret-delivery ServiceAccount.

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

Create it through `auth/token/create-orphan`. The policy permits only four runtime writes and self-revocation.

Enter it through the hidden `BAO_DEPLOY_TOKEN` environment input.

Do not use GitHub OIDC fields at the same time.

The handoff revokes the token after its four writes. Unset the input after the command.

## Apply and verify

Apply only the reviewed production plan. Use the same commit that produced the plan.

Verify D1 and R2 report EU jurisdiction. Verify each Queue consumer and dead letter Queue.

Verify Access protects Bob and the agent host. Verify the ingress host remains public.

Enable the reviewed credential handoff only in trusted GitHub Actions.

Sync generated Access and Tunnel credentials through the approved handoff.

Write the three Access records and Tunnel token directly to OpenBao.
Do not store them in workflow artifacts or command output.

Confirm External Secrets creates the required `bob-agent-bootstrap` Secret.

The agent container must not start when that Secret is absent.

Stop when the secret workflow or scoped OpenBao role is absent.

Access service tokens expire after seven days.

Increment `ACCESS_SERVICE_TOKEN_ROTATION_VERSION` for each rotation.

Set `ACCESS_SERVICE_TOKEN_ROTATE_BY` between 24 hours and eight days ahead.

Rotate and sync all three service tokens before that deadline.

Never print a service secret or Tunnel token. Store only runtime copies in OpenBao.

Run the Sendblue reconciler after the ingress URL is stable.

Run one harmless round trip. Then verify duplicate and timeout states in D1.

The checked-in manifest uses unresolved repository and digest inputs.

The readiness check rejects unresolved, mutable, or local-only images.

The repository does not publish images or synchronize live secrets.

## Production safety

Production D1, R2, and Queues use retain policies.

Never run `alchemy unsafe nuke` for Bob.

Do not remove retained resources to simulate a reset.
