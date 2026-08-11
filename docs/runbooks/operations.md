# Operations runbook

## Daily checks

Check Queue age, failed messages, uncertain sends, and overdue reminders.

Check the last provider completion. Check OAuth refresh and authentication failures.

Use only opaque correlation identifiers. Never search logs for user text or phone numbers.

Open the private Alerts page. It contains identifiers and status only.

Use **Review safely** only after you inspect the related durable state.

Only the owner can run an alert recovery action.

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
