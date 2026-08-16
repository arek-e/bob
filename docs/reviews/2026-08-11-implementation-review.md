# Implementation review

Date: 2026-08-11

Reviewers:

- Two independent `gpt-5.6-terra` reviewers at ultra effort.
- One independent `gpt-5.6-sol` reviewer at max effort.

Status: remediation required

The three reviewers inspected the frozen implementation.

All static checks passed before this review.

The green check did not prove the runtime and recovery paths.

## Release blockers

1. Alchemy beta.70 cannot start with Effect beta.107.
2. Core does not authenticate and authorize each route in code.
3. An inbound retry rebuilds a different agent-run snapshot.
4. A completed run can lose its response intent after a crash.
5. An uncertain Sendblue send can remain claimed forever.
6. Reminder delivery does not create reply bindings.
7. Reminder delivery does not enter `awaiting_response`.
8. Scheduler commands do not update the Reminder Clock alarm.
9. The model can confirm its own memory proposal.
10. Provider opt-out and resume state is not durable.
11. A fast provider callback can arrive before handle binding and remain unmatched.
12. The agent listens on loopback while the Tunnel targets its Service.

## Required high-risk fixes

1. Load old KEK versions and use a separate stable lookup key.
2. Encrypt sensitive memory values and omit plaintext sensitive search data.
3. Remove unsupported facts and their search data after source deletion.
4. Make journal handoff consumption atomic with entry creation.
5. Add leases and recovery to tool attempts.
6. Add ownership, relationship, state, and approval checks to training writes.
7. Keep Sendblue ingress and egress disabled until production setup is ready.
8. Select the EU Durable Object jurisdiction before each object lookup.
9. Add restrictive Kubernetes egress policy.
10. Separate agent run identity from device-login administration identity.
11. Sync generated Access and Tunnel credentials without logging them.
12. Add immutable image inputs, `.dockerignore`, and secret provisioning gates.
13. Accept every documented Sendblue status and prevent state regression.
14. Bound the complete context pack and each context item.
15. Recover inbound work after Job Queue exhaustion.
16. Preserve typed agent failure codes instead of mapping every failure to timeout.
17. Bound device-login startup and require an approved production completion and refresh check.
18. Run the composed Effect Layers instead of keeping them compile-only.

## Required tests

Add tests that prove these cases:

- Alchemy can load and evaluate the stack.
- Core rejects the wrong caller on every protected route.
- D1 migrations apply in the Workers test runtime.
- An Application Storage transaction rolls back after an injected failure.
- An inbound lease can expire and reuse the same snapshot.
- A completed run repairs a missing response outbox.
- A lost Sendblue result becomes uncertain and does not resend.
- A callback before handle binding is replayed later.
- Late callbacks do not regress a terminal state.
- STOP blocks all delivery and START resumes delivery.
- A Scheduler command updates one Run Coordinator wake.
- Alarm failure and lease expiry recover without duplicate occurrences.
- Accepted delivery creates one expiring reply binding.
- `SEEN` acknowledges and `DONE` completes the targeted occurrence.
- Ambiguous short replies do not mutate state.
- The model cannot confirm a memory candidate.
- Journal deletion removes or disputes every unsupported derived fact.
- Old encrypted records remain readable after KEK rotation.
- Training stops after pain or machine confusion.
- Disabled Sendblue configuration creates no delivery resource.
- The agent Service and probes can reach the listener.

## External gates

These items need live infrastructure or user approval:

- Cloudflare production plan and deployment.
- Immutable image publication.
- OpenBao and Kubernetes role creation.
- Access and Tunnel secret synchronization.
- Live Sendblue signature, callback, opt-out, and regional tests.
- Live Pi login, completion, restart, refresh, and revocation tests.
- Backup, restore, retention, deletion, and EU placement evidence.
- Quiet hours and daily notification limits.

Do not describe an external gate as complete until its evidence exists.
