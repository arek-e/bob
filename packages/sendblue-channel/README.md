# Sendblue Channel Adapter

This package contains the shared implementation of Bob's selected Channel Adapter.

- Ingress receives untrusted Sendblue webhooks. It has no outbound provider credential.
- Egress consumes outbound jobs and owns the Sendblue send credential.

Core remains authoritative for channel events, delivery claims, attempts, and results. The two
paths keep separate bindings and credential boundaries.

The Channel Runtime runs both paths in one Node process with the selected Job Queue Adapter.
