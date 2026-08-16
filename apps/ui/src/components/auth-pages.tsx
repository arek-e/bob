import { Link } from "@tanstack/solid-router"
import { createSignal, onMount, Show, type JSX } from "solid-js"

import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { apiBase, loadOwnerSession, safeReturnPath } from "~/lib/api"
import { styles } from "~/lib/styles"

export function SignInPage() {
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [error, setError] = createSignal("")
  const [status, setStatus] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)

  onMount(async () => {
    try {
      if ((await loadOwnerSession()) !== null) window.location.assign(safeReturnPath())
    } catch {
      setStatus("Unable to check your session. Check your connection and try again.")
    }
  })

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    setError("")
    setStatus("")
    if (email().trim().length === 0) {
      setError("Enter the owner email address.")
      document.getElementById("sign-in-email")?.focus()
      return
    }
    if (password().length === 0) {
      setError("Enter the owner password.")
      document.getElementById("sign-in-password")?.focus()
      return
    }
    setSubmitting(true)
    try {
      const response = await fetch(`${apiBase}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email().trim(), password: password(), rememberMe: true })
      })
      if (!response.ok) {
        setError("Email or password is incorrect. Check both fields and try again.")
        return
      }
      window.location.assign(safeReturnPath())
    } catch {
      setStatus("Unable to sign in. Check your connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthFrame
      title="Welcome to Bob"
      subtitle="Owner settings"
      description="Use the owner account to manage Bob."
    >
      <div class={styles.authStatus} role="status" aria-live="polite">
        {status()}
      </div>
      <form class={styles.authForm} novalidate onSubmit={(event) => void submit(event)}>
        <div class={styles.fieldGroup}>
          <Label for="sign-in-email">Email</Label>
          <Input
            id="sign-in-email"
            name="email"
            type="email"
            autocomplete="username"
            spellcheck="false"
            required
            value={email()}
            aria-describedby={error().length > 0 ? "sign-in-error" : undefined}
            aria-invalid={error().length > 0}
            onInput={(event) => {
              setEmail(event.currentTarget.value)
              setError("")
            }}
          />
        </div>
        <div class={styles.fieldGroup}>
          <Label for="sign-in-password">Password</Label>
          <Input
            id="sign-in-password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            value={password()}
            aria-describedby={error().length > 0 ? "sign-in-error" : undefined}
            aria-invalid={error().length > 0}
            onInput={(event) => {
              setPassword(event.currentTarget.value)
              setError("")
            }}
          />
        </div>
        <Show when={error().length > 0}>
          <p id="sign-in-error" class={styles.fieldError} role="alert">
            {error()}
          </p>
        </Show>
        <Button size="lg" type="submit" disabled={submitting()}>
          {submitting() ? "Signing in…" : "Continue with email"}
        </Button>
      </form>
      <p class={styles.authHelp}>
        First visit? <a href="/setup">Set up the owner login</a> through the protected setup route.
      </p>
      <p class={styles.authTerms}>
        This is a private settings app. Only the owner account can open it.
      </p>
    </AuthFrame>
  )
}

export function SetupPage() {
  const [setupToken, setSetupToken] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [confirmation, setConfirmation] = createSignal("")
  const [passwordError, setPasswordError] = createSignal("")
  const [confirmationError, setConfirmationError] = createSignal("")
  const [setupTokenError, setSetupTokenError] = createSignal("")
  const [status, setStatus] = createSignal("")
  const [setupState, setSetupState] = createSignal<
    "loading" | "required" | "complete" | "unavailable"
  >("required")
  const [submitting, setSubmitting] = createSignal(false)

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    setSetupTokenError("")
    setPasswordError("")
    setConfirmationError("")
    if (setupToken().length < 32) {
      setSetupTokenError("Enter the setup token from your Compose environment.")
      document.getElementById("setup-token")?.focus()
      return
    }
    if (password().length < 12) {
      setPasswordError("Use at least 12 characters.")
      document.getElementById("setup-password")?.focus()
      return
    }
    if (password() !== confirmation()) {
      setConfirmationError("Enter the same password in both fields.")
      document.getElementById("setup-password-confirmation")?.focus()
      return
    }
    setSubmitting(true)
    try {
      const response = await fetch(`${apiBase}/setup/api`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-setup-token": setupToken()
        },
        body: JSON.stringify({ password: password() })
      })
      if (response.status === 409) {
        setSetupState("complete")
        setStatus("The owner login already exists.")
        return
      }
      if (!response.ok) {
        setStatus("Unable to create the owner login. Refresh this page and try again.")
        return
      }
      setStatus("Owner login created. Opening settings…")
      window.location.assign("/settings")
    } catch {
      setStatus("Unable to create the owner login. Check your connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthFrame
      eyebrow="Protected owner setup"
      title="Create the owner login"
      subtitle="Keep Bob private"
      description="Choose the password that you will use to open Bob. This setup works once."
    >
      <div class={styles.authStatus} role="status" aria-live="polite">
        {status()}
      </div>
      <Show
        when={setupState() === "required"}
        fallback={
          <Show
            when={setupState() === "complete"}
            fallback={<p class={styles.authHelp}>{status()}</p>}
          >
            <p class={styles.authHelp}>
              The owner login already exists. <a href="/sign-in">Continue to sign in</a>.
            </p>
          </Show>
        }
      >
        <form class={styles.authForm} novalidate onSubmit={(event) => void submit(event)}>
          <div class={styles.fieldGroup}>
            <Label for="setup-token">Setup token</Label>
            <Input
              id="setup-token"
              name="setupToken"
              type="password"
              autocomplete="off"
              required
              value={setupToken()}
              aria-describedby="setup-token-hint setup-token-error"
              aria-invalid={setupTokenError().length > 0}
              onInput={(event) => {
                setSetupToken(event.currentTarget.value)
                setSetupTokenError("")
              }}
            />
            <p id="setup-token-hint" class={styles.hint}>
              Use the value of SETUP_TOKEN from your local environment.
            </p>
            <Show when={setupTokenError().length > 0}>
              <p id="setup-token-error" class={styles.fieldError} role="alert">
                {setupTokenError()}
              </p>
            </Show>
          </div>
          <div class={styles.fieldGroup}>
            <Label for="setup-password">Password</Label>
            <Input
              id="setup-password"
              name="password"
              type="password"
              minlength="12"
              maxlength="128"
              autocomplete="new-password"
              required
              value={password()}
              aria-describedby="setup-password-hint setup-password-error"
              aria-invalid={passwordError().length > 0}
              onInput={(event) => {
                setPassword(event.currentTarget.value)
                setPasswordError("")
              }}
            />
            <p id="setup-password-hint" class={styles.hint}>
              Use at least 12 characters.
            </p>
            <Show when={passwordError().length > 0}>
              <p id="setup-password-error" class={styles.fieldError} role="alert">
                {passwordError()}
              </p>
            </Show>
          </div>
          <div class={styles.fieldGroup}>
            <Label for="setup-password-confirmation">Confirm password</Label>
            <Input
              id="setup-password-confirmation"
              name="passwordConfirmation"
              type="password"
              minlength="12"
              maxlength="128"
              autocomplete="new-password"
              required
              value={confirmation()}
              aria-describedby="setup-password-confirmation-error"
              aria-invalid={confirmationError().length > 0}
              onInput={(event) => {
                setConfirmation(event.currentTarget.value)
                setConfirmationError("")
              }}
            />
            <Show when={confirmationError().length > 0}>
              <p id="setup-password-confirmation-error" class={styles.fieldError} role="alert">
                {confirmationError()}
              </p>
            </Show>
          </div>
          <Button size="lg" type="submit" disabled={submitting()}>
            {submitting() ? "Creating owner login…" : "Create owner login"}
          </Button>
        </form>
      </Show>
      <p class={styles.authFooter}>
        <Link to="/sign-in">Back to sign in</Link>
      </p>
    </AuthFrame>
  )
}

function AuthFrame(props: {
  eyebrow?: string
  title: string
  subtitle?: string
  description: string
  children: JSX.Element
}) {
  return (
    <main class={styles.authLayout}>
      <header class={styles.authHeader}>
        <a class={styles.authLogo} href="/" aria-label="Bob home">
          <span class={styles.authLogoMark} aria-hidden="true">
            <span class={styles.authLogoDot} />
            <span class={styles.authLogoDot} />
            <span class={styles.authLogoDot} />
            <span class={styles.authLogoDot} />
          </span>
          <span class={styles.authLogoName}>Bob</span>
        </a>
      </header>
      <div class={styles.authHero}>
        <Card
          class={styles.authCard}
          aria-labelledby="auth-title"
          aria-describedby="auth-description"
        >
          <CardHeader>
            <Show when={props.eyebrow}>
              <p class={styles.authKicker}>{props.eyebrow}</p>
            </Show>
            <h1 class={styles.authTitle} id="auth-title">
              {props.title}
              <Show when={props.subtitle}>
                <span class={styles.authTitleMuted}>{props.subtitle}</span>
              </Show>
            </h1>
            <CardDescription id="auth-description">{props.description}</CardDescription>
          </CardHeader>
          <CardContent>{props.children}</CardContent>
        </Card>
      </div>
    </main>
  )
}
