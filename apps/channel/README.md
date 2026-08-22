# Sendblue Channel Adapter

This app contains Bob's selected Channel Adapter and its runtime implementation.

- Ingress receives untrusted Sendblue webhooks. It has no outbound provider credential.
- Egress consumes outbound jobs and owns the Sendblue send credential.

Core remains authoritative for channel events, delivery claims, attempts, and results. The two
paths keep separate bindings and credential boundaries.

The Channel Runtime runs both paths in one Node process with the selected Job Queue Adapter. The
Sendblue provider, wire schemas, workflows, and Effect Layers stay local to this app.

On boot, the Channel reconciles the configured Sendblue receive and outbound hooks. This operation
runs after the HTTP listener starts and fails open. Scheduled history recovery remains a fallback;
its replay events are marked separately from live webhook delivery in telemetry.
