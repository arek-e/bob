# Bob Runtime

Bob Runtime is an AGPLv3-licensed application and self-hosting contract for a
private continuity assistant.

It uses iMessage through Sendblue. It stores application data in Cloudflare D1.

Managed production operations live in the private Bob Control Plane repository.
Local checks use explicit fixtures and create no cloud environment.

The Runtime is licensed under the GNU Affero General Public License, version 3.
See [LICENSE](LICENSE). The private Control Plane is not part of this repository.

The private `/settings` page manages owner locality and connection status.

The owner can also change locality through Bob's Sendblue conversation.

See [CONTEXT.md](CONTEXT.md) for domain rules and the [ADR index](docs/adr/README.md) for architecture decisions.

## Local checks

Use Node 22.19 or newer and pnpm 10.19.0.

```sh
corepack enable
corepack prepare pnpm@10.19.0 --activate
pnpm install --frozen-lockfile
pnpm check
```

Use the shorter agent gate during agent work:

```sh
pnpm agent:check
```

Run the live suite after a candidate agent is reachable through Cloudflare Access:

```sh
pnpm agent:smoke:predeploy
```

The suite checks authentication, structured output, repair, conflict handling, and training safety. It does not prove the Sendblue channel.

Complete acceptance starts with `List my reminders.` from the allowlisted owner. It requires a completed run, `reminder_list`, an `agent_reply` outbox, and delivered Sendblue status. Follow [deployment.md](docs/runbooks/deployment.md).

Do not put secrets in local environment files. Use Varlock and OpenBao.

See [deployment.md](docs/runbooks/deployment.md) before any cloud change.
