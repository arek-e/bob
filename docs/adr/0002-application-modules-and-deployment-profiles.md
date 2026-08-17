# ADR 0002: Application Modules and Deployment Profiles

Status: Accepted
Date: 2026-08-17

## Context

Bob stored business Modules in separate `features` and `domains` directories. These directory names
duplicated the selection already expressed by Deployment Profiles.

The transitional profile also constructed each Vertical Module from many public factories. This exposed
Module internals and placed business configuration rules in App Core.

Profile ownership was split across Core types, App Core, and Agent Worker. Core types therefore depended on
all optional Vertical Module Interfaces.

## Decision

Store all business Modules under `packages/application`. Each Module keeps its `types` and `service`
projects. The package name remains its public identity.

An Application Module owns business rules, storage, workflows, and Adapters. A Vertical Module exposes one
prepared Interface. This Interface owns its configuration validation and returns its Tool, Context, route,
workflow, schedule, evidence, artifact, and delivery contributions.

Create one logical Deployment Profile Module with two views:

- The definition view owns the immutable Capability catalogue. Agent Worker uses this view.
- The runtime view selects prepared Vertical Modules. Core Runtime uses this view.

Conformance tests bind both views to the same profile identity and Capability Module order. Profiles remain
static and reviewed. Core and Agent reject catalogue generation differences before model execution.

App Core acquires raw configuration values and hosting resources. Each selected Application Module validates
and interprets its own configuration values.

Keep Runtime Modules separate. They provide hosting and provider Adapters. They do not own business policy.

Do not fetch profiles at runtime. Do not add discovery, self-registration, hot reload, or mutable hooks.

## Consequences

The `features` and `domains` directory distinction is removed. Deployment Profiles become the authoritative
source for optional Module selection.

Core types no longer depend on optional Application Modules. Agent Worker depends only on the profile
definition view.

App Core composes a prepared Vertical Module through one Interface. It does not import the Module's internal
factories.

The Core profile remains the default. The transitional profile stays unsupported until its Runtime Adapters
and configuration are complete.

A package-graph test prevents General Agent Core Implementations from importing Vertical Module
Implementations.
