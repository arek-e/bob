# Pi authentication runbook

Pi stores the complete `openai-codex` OAuth record in OpenBao.

Do not copy `~/.codex/auth.json`. Do not place OAuth fields in environment variables.

## Start login

Open the private Bob UI. Go to **Agent access**.

Select **Start Codex login**. Open the displayed sign-in page.

Enter the displayed device code. The code can contain nine characters.

Return to Bob. Select **Check access** after sign-in completes.

## Verify persistence

Restart the single agent pod. Keep one replica during the restart.

Check access again. Run the required, owner-approved production smoke command.

```sh
pnpm --filter @bob/pi-smoke smoke -- --completion
```

The command must report a completed admin model smoke.

Restart the agent pod. Run the same command again.

Confirm the OpenBao record version increased after a refresh.

Keep production blocked until completion, restart, and refresh evidence exists.

Never inspect the OAuth value through logs or an agent transcript.

## Recover

If login remains active, wait for its expiry. Then start a new login.

If refresh fails, stop agent runs. Do not switch to API billing automatically.

Use the credential administration policy only for explicit credential deletion.
