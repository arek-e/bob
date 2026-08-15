# ADR 0013: Use one shared Connections Gateway for managed Bob Instances

- Status: Accepted
- Date: 2026-08-15
- Scope: External connection isolation and managed Nango deployment
- Related: Bob Control Plane ADR 0005, "Keep connection authority outside the Control Plane"

## Context

Each Bob Instance currently deploys Nango, Redis, and a separate Nango database.

The core Worker receives the Nango environment secret.

This design gives each Instance strong isolation, but repeats expensive infrastructure.

It also prevents one managed Nango deployment from serving many Bob Instances safely.

The Nango environment secret can access every connection in its environment.

A shared secret in each Bob Instance would break Instance isolation.

## Decision

Run one shared Connections Gateway and Nango deployment per managed environment or region.

The Connections Gateway is an application data-plane Module.

It is not part of the Bob Control Plane.

Each Bob Instance calls the Connections Gateway with a unique managed identity.

The Connections Gateway derives the Instance ID from verified identity.

It never accepts Instance scope from request content.

The Connections Gateway owns the Nango environment secret and provider integration mapping.

It accepts Bob provider names, not arbitrary Nango integration identifiers.

It namespaces each Nango owner reference with the Instance ID and Owner ID.

It filters every Nango response against that namespace before it returns metadata.

It never returns provider credentials, Nango tags, Nango secrets, or raw upstream errors.

The core Worker keeps content-free connection status in its Instance database.

The Bob Control Plane stores only a Connections Gateway assignment and projection status.

Self-hosters can deploy a private Connections Gateway and Nango environment.

## Consequences

Managed Bob Instances share Nango infrastructure without sharing Nango authority.

One Nango upgrade serves all managed Bob Instances in its environment or region.

The Connections Gateway becomes required for new connection sessions and status refreshes.

Existing reminders and normal Bob requests continue when the Connections Gateway is unavailable.

A managed deployment needs a durable Instance identity registry.

The Nango deployment needs shared backup, recovery, and availability policy.

Dedicated Nango deployments remain possible for high-isolation customers.
