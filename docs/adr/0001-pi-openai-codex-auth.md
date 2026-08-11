# ADR 0001: Store Pi OpenAI Codex OAuth credentials in OpenBao

- Status: Accepted for the feasibility spike
- Date: 2026-08-10
- Scope: Bob's private Pi runtime

## Context

Bob should use the owner's ChatGPT subscription when OpenAI permits this use.

OpenAI supports ChatGPT sign-in and API-key sign-in for Codex.

API keys use separate usage billing. Bob must never enable that billing without approval.

Pi 0.84.1 implements ChatGPT OAuth through its `openai-codex` provider.

Pi calls `https://chatgpt.com/backend-api/codex/responses` for this provider.

OpenAI does not document this backend as a public API contract.

This connection can change without notice. Treat it as a tested feasibility path.

## Decision

Use Pi's public provider and login interfaces. Do not copy Pi's OAuth code.

Pin these packages to version 0.84.1:

- `@earendil-works/pi-ai`

Register the provider through Pi:

```ts
const models = createModels({ credentials: openBaoCredentialStore })
models.setProvider(openaiCodexProvider())

await models.login("openai-codex", "oauth", interaction)
```

Select `device_code` during server bootstrap.

Show the verification URL and user code in the private administration surface.

Never send an OAuth code through Sendblue.

## Pi login flow

Pi's device flow uses these steps:

1. Pi starts a request at `https://auth.openai.com/api/accounts/deviceauth/usercode`.
2. Bob shows `https://auth.openai.com/codex/device` and the user code.
3. The owner signs in with the intended ChatGPT account.
4. Pi polls `https://auth.openai.com/api/accounts/deviceauth/token`.
5. Pi exchanges the returned code at `https://auth.openai.com/oauth/token`.
6. Pi stores the returned OAuth credential through `CredentialStore`.

The device flow expires after 15 minutes.

OpenAI requires device-code authorization in the owner's ChatGPT security settings.

Pi also supports browser login with authorization code and PKCE.

Browser login redirects to `http://localhost:1455/auth/callback` by default.

The server bootstrap uses device login because it does not depend on localhost redirects.

## Credential record

Use one OpenBao KV v2 path for the production Pi provider.

Use this fixed path:

```text
ops/apps/prod/bob/pi-auth/openai-codex
```

Store Pi's complete credential as one atomic record:

```json
{
  "type": "oauth",
  "access": "<secret>",
  "refresh": "<secret>",
  "expires": 0,
  "accountId": "<secret>"
}
```

`expires` is Unix time in milliseconds.

Validate every field after each read. Never return token values from `list()`.

The runtime policy can read, create, and update only this provider path.

A separate administration policy controls credential deletion.

Use OpenBao Kubernetes authentication. Do not place these credentials in environment files.

Do not store these credentials in D1, R2, logs, traces, prompts, or Sendblue.

## Account binding

Pi reads the ChatGPT account identifier from the access token.

The claim name is `https://api.openai.com/auth.chatgpt_account_id`.

The OpenAI authorization session selects the account or workspace.

Pi sends these request headers:

```text
Authorization: Bearer <access-token>
chatgpt-account-id: <JWT account identifier>
originator: pi
```

Pi uses the current access-token claim for each request.

The stored `accountId` is metadata. It is not the request source of truth.

## Refresh contract

Pi refreshes the credential five minutes before expiry.

The refresh request has a 15-second timeout.

Pi requires a new access token, refresh token, and expiry value.

The OpenBao store must save both rotated tokens in one write.

Implement refresh inside `CredentialStore.modify()`.

Use one local mutex for each provider. Lock the complete read, refresh, and write operation.

Read the current KV version before the callback. Write with KV v2 compare-and-set.

Do not run the callback again after a compare-and-set conflict.

Discard the losing result. Read the winning credential and fail the current request safely.

A failed refresh keeps the last stored credential.

Never switch to an API key after a refresh failure.

Run one active Pi process in the first release.

Use a recreate deployment strategy. Do not overlap old and new Pi processes.

Add a distributed provider lock before Bob adds another Pi replica.

## Operations

The administration surface supports these actions:

- Start device login.
- Show login expiry without showing tokens.
- Report the bound account identifier in redacted form.
- Report credential expiry.
- Replace the credential through a new login.
- Revoke the credential through an explicit administration action.

Do not expose these actions as Pi tools.

Do not expose these actions through Sendblue commands.

Redact authorization codes, access tokens, refresh tokens, and token response bodies.

Fail closed when login, refresh, quota, or provider access fails.

## Verification gates

Before this path becomes the default:

1. Complete one device login into the OpenBao store.
2. Confirm the stored field shape without printing values.
3. Complete one live Pi request with the selected model.
4. Force a near-expiry credential and verify one serialized refresh.
5. Verify both rotated tokens reach one new KV version.
6. Verify a refresh failure preserves the prior KV version.
7. Verify no API-key provider starts automatically.
8. Verify logs and traces contain no OAuth material.

Repeat the live compatibility check after every Pi upgrade.

## Consequences

Bob can use the same user-facing ChatGPT login method as Pi.

Bob does not depend on Pi's local `auth.json` file.

OpenBao becomes the only runtime credential authority.

Subscription limits and undocumented backend changes can stop requests.

The provider remains replaceable. An API-key provider requires a separate approval and budget.

## Sources

- [OpenAI authentication](https://learn.chatgpt.com/docs/auth)
- [Pi OpenAI OAuth flow](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/auth/oauth/openai-codex.ts)
- [Pi credential types](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/auth/types.ts)
- [Pi refresh behavior](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/auth/resolve.ts)
- [Pi credential store](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/auth/credential-store.ts)
- [Pi model login](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/models.ts)
- [Pi Codex request path](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/api/openai-codex-responses.ts)
