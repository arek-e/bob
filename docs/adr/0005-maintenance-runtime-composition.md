# ADR 0005: Direct maintenance runtime composition

Status: Accepted
Date: 2026-08-23

## Context

The root maintenance CLI previously called Core HTTP routes. That made a local repository tool depend on a
deployed route, caller token, and running Core process. It also prevented maintenance scripts from using the same
Application Module Interfaces and Database Module that the Runtime uses.

Bob needs one reviewed place for commands such as database migration, bounded production reads, and future PIM
maintenance work. The command must remain agent-usable and must not become a shell or arbitrary SQL console.

## Decision

Give `tools/` its own maintenance runtime composition. The composition opens the shared PostgreSQL Database
Module, exposes the existing Operations Module and a read-only ConversationStore view, and runs the existing
Database migration program. Commands call these Interfaces directly.

Keep the command registry static. Commands do not load runtime plugins, execute arbitrary shell commands, or
accept a database URL, key, cookie, or token as a command-line argument.

Keep message content separate from metadata. A content command requires one explicit owner, a bounded query, and
an explicit maintenance content approval value. This approval is an operator guardrail, not a replacement for
Better Auth. The command calls `ConversationStore.listMessages` instead of duplicating decryption or repository
logic. The all-message variant requires an explicit window of no more than 31 days and caps the result at 1,000
messages. It does not provide a cross-owner export.
The result marks a cap-sized page as possibly incomplete, so operators must split the window to continue.

Keep the Core HTTP inspector routes as a separate remote compatibility path until a later removal decision. The
maintenance CLI must not depend on those routes.

Give `tools/` a separate Varlock environment contract. The contract imports only the shared OpenBao connection
settings and resolves an allowlist of database and data-protection fields from the existing Runtime Cluster KV
secret. It does not duplicate secret values in the repository or expose them as command-line arguments. Local
process values override OpenBao values, which supports tests and approved local fixtures. Trusted automation can
use the imported short-lived OIDC role; local operators can use the Bao CLI token.

Keep discovery commands independent from secret resolution. The maintenance entrypoint runs `help` directly and
uses `varlock run --inject vars` for database commands. This keeps the command agent-usable while preventing the
Varlock environment blob from entering the child process.

## Consequences

Maintenance commands use the same database queries, migration behavior, encryption handling, and domain rules as
the Runtime. A command can run without a Core HTTP process.

The maintenance process needs an approved PostgreSQL access path. Metadata commands need `DATABASE_URL`. Message
content also needs the data-protection values and an explicit approval setting. These values must stay in a
secret-safe provider and must not be projected to an agent or ordinary Runtime process without a separate review.
OpenBao policy must grant the maintenance operator or trusted automation read access to the exact Runtime Cluster
KV path before the Varlock fallback can resolve.

The CLI now has a deeper interface: commands receive a small runtime handle instead of knowing transport details.
Future commands can use the same seam after their read/write scope and safety rules are reviewed.
