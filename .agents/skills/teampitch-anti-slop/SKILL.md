---
name: teampitch-anti-slop
description: Use before changing TypeScript or JavaScript code when the repository enables the shared anti-slop Oxlint rules.
---

<!-- teampitch:dev-tools managed -->

# Shared anti-slop rules

The repository enables the local anti-slop Oxlint plugin from `tools/oxlint/anti-slop`.

## Workflow

1. Run the repository lint command before changing a reported pattern.
2. Replace widened values with the narrow type at the boundary that produces them.
3. Keep typed parameters and return values explicit where the rule requires them.
4. Keep type assertions close to the checked value and explain non-obvious safety in a short comment.
5. Use direct calls and explicit object construction when they express the contract.
6. Keep tests on real seams. Use dependency injection or a focused fake instead of module mocking.

The lint configuration is the source of truth for enabled rule names and severity. Do not disable a rule to hide a finding.

## Completion

Finish when the targeted lint command passes and every changed assertion or boundary has an explicit safety reason.
