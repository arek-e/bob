# Incident: inbound messages did not reach Bob

## Status

Service restored on 2026-08-13.

Bob accepted the next confirmed owner message at 17:54 CEST.

The inbound recovery controls reached production at 20:30 CEST.

## Impact

The owner sent messages around lunch and received no response.

The exact message count is unknown. Sendblue did not record these messages.

## Time window

The investigation used 10:00 through 16:00 CEST on 2026-08-13.

The first confirmed recovery message reached Sendblue at 17:54 CEST.

## Cause

The first failed boundary was before Sendblue message acceptance.

Sendblue history contains no inbound message in the incident window. Cloudflare received no Sendblue webhook POST in that window.

Bob, D1, the agent, and the private runtime did not receive the missing messages.

The available provider API does not show the internal Sendblue or Apple network cause. The exact external cause is unknown.

## Evidence

- D1 contains no inbound event from 10:00 through 16:00 CEST.
- Tempo contains no Bob ingress trace in that window.
- Loki contains no Bob ingress event in that window.
- Cloudflare contains no POST to either Sendblue webhook path in that window.
- Sendblue message history contains no inbound message in that window.
- The physical host, KVM guest, and Docker did not restart in that window.
- The Sendblue webhook URLs and signing secret match the reviewed configuration.
- The recovery message exists in Sendblue history at 15:54:13 UTC.
- Cloudflare accepted its receive webhook with HTTP 202.
- D1 accepted the same workflow at 15:54:15 UTC.

## Resolution

The provider accepted a later owner message without a Bob code change.

The release deployment republished the Workers. It did not change the ingress handler. Evidence does not show that deployment caused recovery.

## Corrective controls

Bob now polls Sendblue inbound history every two minutes.

The egress Worker has a direct two-minute Cron Trigger. Bob's existing core scheduler also invokes
the authenticated egress recovery endpoint on even UTC minutes.

The core fallback was added after Cloudflare registered the direct trigger but did not invoke it
within the documented release window.

Production acceptance found that Sendblue rejected the documented `limit=1000` history query.
The live endpoint accepts at most 100. Bob now uses the verified live limit for inbound and outbound
history queries.

Each poll uses a 15-minute overlap. It selects only the approved line and owner. It replays valid records through the normal signed ingress path.

D1 deduplicates each replay by account, line, and provider message handle.

Each poll also confirms that the configured line remains assigned. A missing line fails the scheduled invocation.

The Coolify observer now checks the public Sendblue ingress health endpoint.

These controls recover provider records when webhook delivery fails. They also detect line removal and ingress route failure.

## Remaining limit

Bob cannot recover a message that never reaches Sendblue history.

An independent inbound channel is required to remove this provider boundary. Provider support can also inspect the missing external delivery.

## Verification

- The history client has bounded-query tests.
- The recovery path has owner-filter and ordering tests.
- The recovery path uses the existing D1 idempotency boundary.
- Source release `28e4f94a37b46034928b5453a45d0fcaacc4569b` passed the full release gate.
- Deployment release `88c1b5e112844cfb9f597b924f3162694a04b38b` pins both attested images.
- The core fallback completed a reconciliation trace at 18:20:25 UTC.
- The direct egress Cron completed at 18:30 UTC with zero missing records.
- Core, ingress, egress, and Nango health routes returned HTTP 200.
- A fresh Bob backup completed its independent copy.
- A fresh Nango backup completed its S3 copy.

## Follow-up work

- [#23](https://github.com/arek-e/bob/issues/23) rotates the exposed Coolify deployment credential.
- [#24](https://github.com/arek-e/bob/issues/24) removes Sendblue as the single acceptance boundary.
- [#25](https://github.com/arek-e/bob/issues/25) removes persistent Alchemy drift.
- [#26](https://github.com/arek-e/bob/issues/26) adds reconciliation metrics and stale-run alerts.
- [#31](https://github.com/arek-e/bob/issues/31) fixes Coolify Compose startup sequencing.
