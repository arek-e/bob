# Engineering checklist

Status: active

## Source quality

- [ ] `pnpm check` passes.
- [ ] `pnpm secrets:scan:trusted` passes.
- [ ] `node scripts/verify-deployment-readiness.mjs` passes.
- [ ] The release commit changes only `infra/coolify/release.json`.
- [ ] The source SHA and both image digests match the registry.

## Runtime assurance

- [ ] Every Compose image uses an immutable digest.
- [ ] The AppRole secret ID enters the agent through a Docker secret file.
- [ ] No Compose service publishes a host port.
- [ ] Agent `/health` reports liveness.
- [ ] Agent `/v1/admin/readiness` reports credentials and Core as ready.
- [ ] The live backup task matches `infra/coolify/runtime-contract.json`.
- [ ] Backup failure notifications are enabled.
- [ ] Bob and Nango backup ages are below 18,000 seconds.
- [ ] One independent backup copy completed.

## Delivery reliability

- [ ] An outbound claim and attempt commit in one D1 batch.
- [ ] The outbound dead-letter Queue has a Core consumer.
- [ ] Recovery republishes only a pending outbox without an attempt.
- [ ] Recovery stops after three decisions.
- [ ] An uncertain delivery reconciles provider status before manual retry.
- [ ] One scheduled recovery failure does not stop unrelated work.

## Acceptance

- [ ] One synthetic inbound event is durable.
- [ ] One agent run uses the reviewed model.
- [ ] One outbound delivery reaches an accepted provider state.
- [ ] One reminder fires and records its delivery result.
- [ ] Telemetry contains no message text or credentials.

## Residual risk

- [ ] The release record accepts the shared private-host failure domain.
- [ ] The release record accepts the shared Cloudflare-account failure domain.
