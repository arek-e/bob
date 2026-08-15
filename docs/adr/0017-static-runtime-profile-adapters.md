# ADR 0017: Static runtime profile Adapters

## Status

Accepted

## Context

ADR 0016 made optional domains Vertical Modules. The Worker still put their rules in Core entrypoints.
Core also changed reminder records inside Delivery. This made profile removal unsafe.

Cloudflare requires Durable Object exports at build time. Runtime discovery cannot select these exports.
The system also needs one atomic D1 batch for delivery and target state changes.

## Decision

Use one reviewed runtime profile at composition time. The profile supplies closed Adapter lists for:

- conversation workflows;
- owner routes;
- scheduled tasks;
- delivery targets;
- Tool commands;
- evidence sources; and
- legacy artifact readers.

Core owns each Adapter Interface and validates duplicate ownership. A Vertical Module owns each
Implementation. Core does not identify an Adapter by domain words.

A conversation workflow prepares an action first. Core applies the turn revision fence. Core then
executes the prepared action. This keeps side effects behind the durable fence.

A delivery target Adapter returns D1 batch statements. Delivery adds these statements to its atomic
state change. It does not use a post-commit hook.

Keep the full migration schema while a profile is unselected. Profile removal stops new access. It
does not delete stored owner data.

Use separate core and transitional capability profile exports. Importing the core export must not
load a Vertical capability.

## Consequences

The core profile composes without reminder or connection configuration. It has no vertical routes,
workflows, schedules, evidence sources, or delivery targets.

The transitional profile keeps current behavior. It owns reminder clock logic and its Durable Object
Implementation.

Each new runtime Adapter adds one conformance test. Boundary checks reject Vertical imports from
General Core files.
