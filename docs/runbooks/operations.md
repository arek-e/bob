# Operations runbook

## Daily checks

Check Queue age, failed messages, uncertain sends, and overdue reminders.

Check the last provider completion. Check OAuth refresh and authentication failures.

Use only opaque correlation identifiers. Never search logs for user text or phone numbers.

Open the private Alerts page. It contains identifiers and status only.

Use **Review safely** only after you inspect the related durable state.

Only the owner can run an alert recovery action.

## Agent telemetry

Cloudflare receives Worker invocation logs and traces. Bob requests full head sampling and trace persistence.

The Node agent writes typed JSON events to standard output.

The production collector accepts only the `agent` container in the `bob` namespace. It sends those logs to Loki.

The collector redacts authentication values, secrets, email addresses, and phone numbers before export.

Open the [Bob Production Overview](https://grafana.lamb-bicolor.ts.net/d/bob-production-overview/bob-production-overview) dashboard from the Tailnet.

The dashboard shows pod health, restarts, failures, safe logs, and Tempo trace searches.

Set the `correlationId` variable to one opaque identifier. Use `.*` to show all recent activity.

Raw log details stay disabled on the dashboard. Use Grafana Explore only for a specific incident.

The Grafana MCP reads its Viewer token from `ops/apps/internal/grafana/mcp` in OpenBao.

Rotate that token before `2027-08-11T18:13:44Z`.

The agent OTLP exporter sends native spans to the production collector. It does not block a request after export failure.

The exporter becomes production evidence only after the matching agent image is released.

Set `BOB_RELEASE_SHA` to the exact source commit for that image.

Cloudflare Worker telemetry stays in Cloudflare until both OTLP destinations are configured.

Filter logs by `correlationId` or `traceId`. Both values are opaque identifiers.

Use these event types for the operations dashboard:

- `workflow_span` measures each workflow boundary.
- `agent_run` measures model status and latency.
- `token_usage` attributes tokens to one feature and workflow.
- `token_budget` shows the run and UTC-day budget state.
- `retrieval` shows selected items, sources, and conflicts.
- `tool_call` shows the tool name, status, and duration.
- `delivery` shows the provider result and duration.

Create latency charts from `workflow_span.durationMs`. Group the charts by `name` and `status`.

Create token charts from `token_usage`. Group the charts by `feature`, `workflow`, and `model`.

Use this D1 query for durable token attribution:

```sql
SELECT
  substr(occurred_at, 1, 10) AS utc_day,
  feature,
  workflow,
  model,
  count(*) AS runs,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens,
  sum(input_tokens + output_tokens) AS total_tokens
FROM agent_usage
GROUP BY utc_day, feature, workflow, model
ORDER BY utc_day DESC, total_tokens DESC;
```

The ChatGPT subscription does not give Bob a per-token price. Treat tokens as quota units, not money.

Alert on failed `model.run`, `tool.execute`, and `provider.send` spans.

Alert when a `token_budget` event has a `warning` or `exceeded` state.

Bob uses a 32,000-token run threshold. Bob uses a 250,000-token UTC-day threshold.

The thresholds create alerts only. They do not stop a request or change the provider.

An `agent_quota_exhausted` alert means the provider rejected a model request for quota.

An `agent_run_failed` alert means a provider, timeout, or output validation failure stopped a run.

A `token_budget_exceeded` alert means measured tokens passed a configured soft threshold.

Never add prompts, messages, tool arguments, phone numbers, or journal text to an event.

## Service objectives

Measure these objectives over a rolling 30-day window.

- Accept 99.5% of valid owner messages into durable storage within 5 seconds.
- Complete 98% of accepted agent runs without an authentication, quota, provider, or output error.
- Create an outbound intent for 95% of completed agent runs within 60 seconds.
- Reach a terminal delivery state for 99% of outbound intents within 5 minutes.
- Claim 99% of due reminders within 5 minutes of their allowed delivery time.

Do not count rejected senders, invalid webhooks, owner opt-outs, or planned maintenance as eligible work.

Use durable timestamps for the result. Do not infer success from a log entry.

Create a content-free alert when one objective exhausts half of its monthly error budget.

Create a second alert when the complete error budget is exhausted.

Review the target after three full months. Do not weaken a target to hide an incident.

The initial recovery objectives are a four-hour recovery point and a one-day recovery time.

## Reminder recovery

Cron reconciles reminders each minute. Alert when recovery takes more than five minutes.

Inspect the D1 claim before any retry. Release only an expired claim.

Treat every Queue event and Durable Object alarm as repeatable.

After six alarm failures, repair the cause. Then run the private retry action.

The Core Worker consumes the inbound dead-letter Queue.
It clears an expired D1 claim and republishes the stored event.
It stops after three recovery cycles.

Inspect `dead_lettered_at` and `recovery_count` before a manual retry.

## Provider uncertainty

Do not retry an uncertain Sendblue request automatically.

Reconcile the provider status first. Warn about possible duplicates before manual retry.

Use the alert recovery action to replay stored provider events.

Do not resend when the provider result is unknown.

Resolve a missed-reminder alert only after owner review.

Do not send the missed reminder again automatically.

## Safety response

Bob is not an emergency or medication system.

Use the fixed urgent-safety response for immediate danger. Direct the owner to human help.
