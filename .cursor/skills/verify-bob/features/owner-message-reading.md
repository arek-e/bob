# Read owner messages

Bob can read bounded messages for one explicit owner through the maintenance runtime or the normal authenticated Core message route. The result must stay owner-scoped and content access needs explicit approval.

## Sub-features

- `latest-messages`: read recent messages with `read-latest-messages`.
- `bounded-window`: read one owner within an explicit UTC window with `read-all-messages`.
- `headless-route`: read the same owner-scoped resource through `GET /api/production-data/messages` with a bearer API key.

## How to get to it (user POV)

- Run `pnpm maint read-latest-messages` with approved maintenance environment values.
- Run `pnpm maint read-all-messages --from <iso> --to <iso>` for a bounded UTC window.
- Call `GET http://127.0.0.1:8788/api/production-data/messages?from=<iso>&to=<iso>&limit=<1-100>` with an owner session or the configured headless bearer key.

## Driving it with the Bob CLI and Core API

Preconditions:

- The owner is explicit through `BOB_OWNER_ID` or a named owner-ID environment variable.
- `BOB_MAINTENANCE_CONTENT_APPROVAL` equals `owner-approved`.
- Varlock has resolved `DATABASE_URL`, `DATA_KEK_ACTIVE_VERSION`, `DATA_KEK_KEYRING_JSON`, and `DATA_LOOKUP_KEY` for the approved target.
- The query uses a bounded window. `read-all-messages` uses UTC, allows at most 31 days, and caps one result at 1,000 messages.

- Action: run `pnpm maint read-latest-messages --from <iso> --to <iso> --limit <1-100>`.
  Result: exit code `0`; JSON contains the normalized `from`, `to`, and owner-scoped `messages` fields. Record only count and redacted metadata in durable evidence.
- Action: run `pnpm maint read-all-messages --from <iso> --to <iso>`.
  Result: exit code `0`; JSON is bounded and marks `possiblyMore=true` when the cap is reached. Split the window before reading more.
- Action: call the normal Core route with an owner session or `Authorization: Bearer ${BOB_HEADLESS_API_KEY}`.
  Result: HTTP `200` with the same bounded message shape. A missing or invalid credential returns `401`; an unscoped headless principal returns `403`.

## Gotchas

- The approval value and owner ID are environment inputs. The commands do not accept them as CLI arguments.
- A successful command with an empty result is valid. It does not prove that a different owner has data.
- Never paste a database URL, API key, keyring, owner ID, or decrypted message body into an artifact.
- Do not call an arbitrary SQL console. The maintenance path must call `ConversationStore`.
- This feature is private-data access. If the required preconditions are missing, report it as skipped.
