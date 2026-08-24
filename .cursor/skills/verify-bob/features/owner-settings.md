# Set up and manage the owner

Bob protects its private settings surface with a one-time setup route and owner authentication, then exposes locality, account, messaging, and delivery settings through the normal owner UI and API.

## Sub-features

- `setup`: create the owner login through `/setup` with the local setup token.
- `sign-in`: authenticate at `/sign-in` with the owner email and password.
- `settings`: read and update `/settings`, including the `Local time and language` form.
- `owner-api`: use `GET` or `PUT /api/settings` with the owner session.

## How to get to it (user POV)

- Open `http://127.0.0.1:8788/setup` for first-time setup.
- Open `http://127.0.0.1:8788/sign-in` after the owner login exists.
- Open `http://127.0.0.1:8788/settings` after sign-in.
- Use `/api/settings` for the same owner settings resource.

## Driving it with the Core HTTP and UI harness

Preconditions:

- Start the local Compose stack with the repository environment configured.
- Confirm `curl --fail --silent --show-error http://127.0.0.1:8788/health` succeeds.
- Use a disposable local database or preserve the existing local owner state. Do not run setup against a shared environment.

- Action: open `/setup`, enter the local `SETUP_TOKEN`, choose a password of at least 12 characters, confirm it, and submit `Create the owner login`.
  Result: the page announces that the owner login was created and opens `/settings`. If the login exists, the page offers `Continue to sign in`.
- Action: open `/sign-in`, fill `Email` and `Password`, and select `Continue with email`.
  Result: the owner session redirects to `/settings`.
- Action: in `/settings`, open `General`, change `Time zone`, `Language`, or `Hour cycle`, and select `Save`.
  Result: the page announces `Locality settings saved.`; a reload shows the saved values.
- Action: with the owner session, call `GET /api/settings`, then `PUT /api/settings` with a valid settings object and call `GET /api/settings` again.
  Result: both responses are `200`; the second read shows the saved value and connection statuses.

## Gotchas

- This is an authenticated UI/API proof, not a maintenance CLI proof. Use a browser or HTTP client only when the Compose stack is running.
- Setup accepts the setup token in the `x-bob-setup-token` header. Keep it out of screenshots and logs.
- `/settings` redirects unauthenticated callers to `/sign-in`.
- The UI's `Messaging` section explains direct iMessage settings instructions; it does not send a test message.
- Delivery status confirms transport only. It does not confirm that Bob performed an action.
