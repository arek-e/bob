# Sendblue Channel Adapter

This package contains the Cloudflare Implementation of Bob's selected Channel Adapter.

The Cloudflare Adapter deploys two Workers:

- The ingress Worker receives untrusted Sendblue webhooks. It has no outbound provider credential.
- The egress Worker consumes outbound jobs and owns the Sendblue send credential.

Core remains authoritative for channel events, delivery claims, attempts, and results. The two
Workers keep separate bindings and release failure domains.

The portable Channel Runtime imports the same public modules. It runs them in one Node process with
the portable Job Queue Adapter.
