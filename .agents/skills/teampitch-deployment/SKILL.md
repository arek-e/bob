---
name: teampitch-deployment
description: Use before changing deployment, infrastructure, OpenBao, ArgoCD, Cloudflare, release, or rollback behavior.
---

<!-- teampitch:dev-tools managed -->

# Shared deployment operations

Bootstrap profile: `deployment`.

Treat the repository's local `AGENTS.md`, `CONTEXT.md`, runbooks, workflows, and manifests as the source of truth.

## Workflow

1. Map the change to its owning repository, environment, workflow, and deployment resource.
2. Read the local deployment guidance and the smallest relevant runbook before editing.
3. Keep credentials in the approved secret manager. Report secret names, paths, versions, and status; never report values.
4. Prefer reviewed GitOps or release workflows. Use direct cluster or provider mutation only for documented recovery, then commit the source fix.
5. Use immutable source revisions, image digests, bundles, or release identifiers when the local contract provides them.
6. Verify readiness, health, logs, and the deployment record after the change. Keep failed evidence for diagnosis.
7. Record the rollback target and the evidence that makes the rollback safe.

## Profile guidance

- `application`: use the application's reviewed CI/CD workflow and its environment contract.
- `deployment`: verify the release contract, immutable artifacts, readiness, and acceptance checks before handoff.
- `infra`: treat this repository as the GitOps source. Keep cluster and provider state changes in source control.

Do not invent paths, resource identifiers, secret fields, or deployment state. Resolve them from the repository contract or a read-only provider query.

## Completion

Finish with the environment, source revision, deployment or operation identifier, health result, rollback target, and secret metadata only.
