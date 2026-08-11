import {
  OwnerSettingsUpdate,
  OwnerSettingsView,
  type ConnectionProvider,
  type HourCycle,
  type SettingsConnection
} from "@bob/contracts/settings"
import {
  DeviceLoginEvent,
  type DeviceLoginEvent as DeviceLoginEventType
} from "@bob/contracts/agent"
import { AdminStatus } from "@bob/contracts/ui"
import { Schema } from "effect"
import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX
} from "solid-js"

import { useOwnerSession } from "~/components/auth"
import { useStatus } from "~/components/app-shell"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Notice } from "~/components/ui/notice"
import { Select } from "~/components/ui/select"
import { api, parseJson, schemas } from "~/lib/api"
import { formatDate, supportedTimeZones } from "~/lib/utils"
import { styles } from "~/lib/styles"

type ClientProps = { enabled: Accessor<boolean> }

function SectionHeader(props: {
  eyebrow: string
  title: string
  id: string
  action?: JSX.Element
}) {
  return (
    <div class={styles.sectionHeading}>
      <div>
        <p class={styles.eyebrow}>{props.eyebrow}</p>
        <h2 class={styles.heading2} id={props.id}>
          {props.title}
        </h2>
      </div>
      {props.action}
    </div>
  )
}

function statusVariant(status: SettingsConnection["status"]): "success" | "warning" | "neutral" {
  if (status === "connected") return "success"
  if (status === "paused" || status === "unavailable") return "warning"
  return "neutral"
}

function statusLabel(status: SettingsConnection["status"]): string {
  if (status === "connected") return "Connected"
  if (status === "paused") return "Paused"
  if (status === "unavailable") return "Unable to check"
  return "Not connected"
}

export function SettingsPage() {
  const [enabled, setEnabled] = createSignal(false)
  onMount(() => setEnabled(true))

  return (
    <>
      <header class={styles.pageIntro}>
        <div class={styles.introCopy}>
          <p class={styles.eyebrow}>Owner administration</p>
          <h1 class={styles.heading1}>Settings</h1>
          <p class={styles.introText}>
            Set how Bob handles local time and link the accounts that Bob uses.
          </p>
        </div>
      </header>
      <div class={styles.dashboardStack}>
        <LocalitySection enabled={enabled} />
        <ConnectionsSection enabled={enabled} />
        <MessageSettingsSection />
        <SendblueHelpSection />
      </div>
    </>
  )
}

function LocalitySection(props: ClientProps) {
  const status = useStatus()
  const [settingsView, { refetch }] = createResource(
    () => (props.enabled() ? "ready" : undefined),
    async () => parseJson(OwnerSettingsView, await api("/api/settings"))
  )
  const [timeZone, setTimeZone] = createSignal(
    typeof Intl === "undefined" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  )
  const [locale, setLocale] = createSignal(
    typeof navigator === "undefined" ? "en" : navigator.language || "en"
  )
  const [hourCycle, setHourCycle] = createSignal<HourCycle>("auto")
  const [timeZoneError, setTimeZoneError] = createSignal("")
  const [localeError, setLocaleError] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)

  createEffect(() => {
    const view = settingsView()
    if (view === undefined) return
    setTimeZone(view.settings.timeZone)
    setLocale(view.settings.locale)
    setHourCycle(view.settings.hourCycle)
    setDirty(false)
  })

  onMount(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty()) return
      event.preventDefault()
    }
    const onFocus = () => {
      if (props.enabled()) void refetch()
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    window.addEventListener("focus", onFocus)
    onCleanup(() => {
      window.removeEventListener("beforeunload", onBeforeUnload)
      window.removeEventListener("focus", onFocus)
    })
  })

  async function save(event: SubmitEvent) {
    event.preventDefault()
    setTimeZoneError("")
    setLocaleError("")
    if (timeZone().length === 0) {
      setTimeZoneError("Choose a time zone.")
      return
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: timeZone() }).format()
    } catch {
      setTimeZoneError("Choose a valid time zone.")
      return
    }

    let canonicalLocale: string
    try {
      const [canonical] = Intl.getCanonicalLocales(locale().trim())
      if (canonical === undefined) throw new Error("Locale is empty")
      canonicalLocale = canonical
    } catch {
      setLocaleError("Use a valid language and region code, such as en-SE.")
      return
    }

    const input = Schema.decodeUnknownSync(OwnerSettingsUpdate)({
      timeZone: timeZone(),
      locale: canonicalLocale,
      hourCycle: hourCycle()
    })
    setSaving(true)
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(input) })
      setLocale(canonicalLocale)
      setDirty(false)
      status.announce("Locality settings saved.")
      await refetch()
    } catch {
      status.announce("Unable to save settings. Check your connection and try again.", true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section id="locality" class={styles.contentSection} aria-labelledby="locality-title">
      <SectionHeader eyebrow="Dates and times" title="Locality" id="locality-title" />
      <div class={styles.settingsGrid}>
        <form
          class={styles.formCard}
          aria-describedby="locality-description"
          novalidate
          onSubmit={(event) => void save(event)}
        >
          <p id="locality-description" class={styles.formIntro}>
            Bob uses these settings for new reminders, replies, and dates in this dashboard.
          </p>
          <div class={styles.fieldGroup}>
            <label class={styles.fieldLabel} for="settings-time-zone">
              Time zone
            </label>
            <Select
              id="settings-time-zone"
              name="timeZone"
              required
              value={timeZone()}
              aria-describedby="settings-time-zone-hint settings-time-zone-error"
              aria-invalid={timeZoneError().length > 0}
              onChange={(event) => {
                setTimeZone(event.currentTarget.value)
                setDirty(true)
              }}
            >
              <For each={supportedTimeZones(timeZone())}>
                {(zone) => <option value={zone}>{zone}</option>}
              </For>
            </Select>
            <p id="settings-time-zone-hint" class={styles.hint}>
              Choose the place whose local clock Bob should use.
            </p>
            <Show when={timeZoneError().length > 0}>
              <p id="settings-time-zone-error" class={styles.fieldError}>
                {timeZoneError()}
              </p>
            </Show>
          </div>
          <div class={styles.fieldGroup}>
            <label class={styles.fieldLabel} for="settings-locale">
              Language and region
            </label>
            <Input
              id="settings-locale"
              name="locale"
              list="settings-locale-options"
              placeholder="en-SE"
              spellcheck="false"
              required
              value={locale()}
              aria-describedby="settings-locale-hint settings-locale-error"
              aria-invalid={localeError().length > 0}
              onInput={(event) => {
                setLocale(event.currentTarget.value)
                setDirty(true)
              }}
            />
            <datalist id="settings-locale-options">
              <option value="en-SE">English (Sweden)</option>
              <option value="sv-SE">Swedish (Sweden)</option>
              <option value="en-GB">English (United Kingdom)</option>
              <option value="en-US">English (United States)</option>
            </datalist>
            <p id="settings-locale-hint" class={styles.hint}>
              Use a language and region code, such as en-SE or sv-SE.
            </p>
            <Show when={localeError().length > 0}>
              <p id="settings-locale-error" class={styles.fieldError}>
                {localeError()}
              </p>
            </Show>
          </div>
          <div class={styles.fieldGroup}>
            <label class={styles.fieldLabel} for="settings-hour-cycle">
              Time format
            </label>
            <Select
              id="settings-hour-cycle"
              name="hourCycle"
              value={hourCycle()}
              onChange={(event) => {
                setHourCycle(event.currentTarget.value as HourCycle)
                setDirty(true)
              }}
            >
              <option value="auto">Follow language and region</option>
              <option value="h23">24-hour time</option>
              <option value="h12">12-hour time</option>
            </Select>
          </div>
          <Button type="submit" disabled={saving()}>
            {saving() ? "Saving…" : "Save locality settings"}
          </Button>
        </form>
        <Notice tone="warning">
          <h3 class={styles.noticeHeading}>Existing reminders stay unchanged</h3>
          <p class={styles.noticeParagraph}>
            A new time zone applies to future requests. Existing reminders keep their saved date,
            time, and time zone.
          </p>
        </Notice>
      </div>
    </section>
  )
}

function ConnectionsSection(props: ClientProps) {
  const status = useStatus()
  const owner = useOwnerSession()
  const [settingsView, { refetch: refetchSettings }] = createResource(
    () => (props.enabled() ? "ready" : undefined),
    async () => parseJson(OwnerSettingsView, await api("/api/settings"))
  )
  const [authStatus, { refetch: refetchAuth }] = createResource(
    () => (props.enabled() ? "ready" : undefined),
    async () => parseJson(AdminStatus, await api("/api/agent/status"))
  )
  const [login, setLogin] = createSignal<DeviceLoginEventType>()
  const [startingLogin, setStartingLogin] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  const [linking, setLinking] = createSignal<ConnectionProvider>()

  const deviceLogin = () => {
    const value = login()
    return value?.type === "device_code" ? value : undefined
  }

  function connection(provider: SettingsConnection["provider"]): SettingsConnection["status"] {
    return (
      settingsView()?.connections.find((item) => item.provider === provider)?.status ??
      "not_connected"
    )
  }

  async function refresh() {
    setRefreshing(true)
    try {
      await Promise.all([refetchSettings(), refetchAuth()])
    } catch {
      status.announce("Unable to refresh connections. Check the service and try again.", true)
    } finally {
      setRefreshing(false)
    }
  }

  async function startLogin() {
    setStartingLogin(true)
    try {
      const event = parseJson(
        DeviceLoginEvent,
        await api("/api/agent/device-login", { method: "POST", body: "{}" })
      )
      setLogin(event)
      if (event.type === "device_code")
        status.announce("Finish sign-in to link your Codex account.")
      if (event.type === "completed") await refetchAuth()
    } catch {
      status.announce(
        "Unable to start Codex login. Check the private agent service and try again.",
        true
      )
    } finally {
      setStartingLogin(false)
    }
  }

  async function linkCalendar(provider: ConnectionProvider, label: string) {
    setLinking(provider)
    try {
      const session = parseJson(
        schemas.connectionSession,
        await api(`/api/connections/${provider}/session`, { method: "POST", body: "{}" })
      )
      window.open(session.connectUrl, "_blank", "noopener,noreferrer")
      status.announce(`Finish linking ${label} in the new window.`)
    } catch {
      status.announce(`Unable to link ${label}. Try again.`, true)
    } finally {
      setLinking(undefined)
    }
  }

  return (
    <section id="connections" class={styles.contentSection} aria-labelledby="connections-title">
      <SectionHeader
        eyebrow="Linked services"
        title="Accounts and connections"
        id="connections-title"
        action={
          <Button variant="secondary" disabled={refreshing()} onClick={() => void refresh()}>
            {refreshing() ? "Refreshing…" : "Refresh connections"}
          </Button>
        }
      />
      <p class={styles.sectionIntro}>
        Link each service once. Bob will use the linked account when a task needs it.
      </p>
      <div class={styles.connectionGrid}>
        <ConnectionCard
          title="Bob owner account"
          description="Controls access to this dashboard and its settings."
          status="connected"
        >
          <p class={styles.hint}>
            Signed in as {owner.user.email}. Better Auth manages this session and future linked
            sign-in accounts.
          </p>
        </ConnectionCard>
        <ConnectionCard
          title="Sendblue"
          description="Use your verified phone number to talk with Bob."
          status={connection("sendblue")}
        >
          <p class={styles.hint}>
            {connection("sendblue") === "connected"
              ? "Messages from the verified owner are linked to Bob."
              : connection("sendblue") === "paused"
                ? "Send START to the Bob number to resume messages."
                : "To link this connection, send any message to Bob from your verified number."}
          </p>
        </ConnectionCard>
        <ConnectionCard
          title="Codex"
          description="Let Bob use your Codex account for agent tasks."
          status={authStatus()?.configured ? "connected" : "not_connected"}
        >
          <p class={styles.hint}>
            {authStatus.loading
              ? "Checking the Codex account…"
              : authStatus()?.configured
                ? `Linked${authStatus()?.accountIdRedacted === undefined ? "" : ` to account ${authStatus()!.accountIdRedacted}`}.${authStatus()?.expiresAt === undefined ? "" : ` Credential expires ${formatDate(authStatus()!.expiresAt!)}`}`
                : "Link your Codex account before Bob can run agent tasks."}
          </p>
          <div class={styles.actionRow}>
            <Button disabled={startingLogin()} onClick={() => void startLogin()}>
              {startingLogin()
                ? "Starting login…"
                : authStatus()?.configured
                  ? "Relink Codex account"
                  : "Link Codex account"}
            </Button>
            <Button variant="secondary" disabled={refreshing()} onClick={() => void refetchAuth()}>
              Check account
            </Button>
          </div>
          <Show when={deviceLogin()}>
            {(event) => (
              <div class={styles.loginCode} aria-live="polite">
                <p class={styles.hint}>Open the sign-in page and enter this code:</p>
                <output class={styles.loginCodeOutput}>{event().userCode}</output>
                <a href={event().verificationUri} target="_blank" rel="noopener noreferrer">
                  Open the Codex sign-in page
                </a>
                <p class={styles.hint}>Code expires {formatDate(event().expiresAt)}.</p>
              </div>
            )}
          </Show>
          <Show when={login()?.type === "completed"}>
            <p class={styles.hint}>Codex login completed.</p>
          </Show>
          <Show when={login()?.type === "failed"}>
            <p class={styles.fieldError}>
              Unable to start login. Finish any active login, then try again.
            </p>
          </Show>
        </ConnectionCard>
        <CalendarConnectionCard
          provider="google_calendar"
          label="Google Calendar"
          status={connection("google_calendar")}
          linking={linking()}
          onLink={() => void linkCalendar("google_calendar", "Google Calendar")}
        />
        <CalendarConnectionCard
          provider="microsoft_calendar"
          label="Outlook Calendar"
          status={connection("microsoft_calendar")}
          linking={linking()}
          onLink={() => void linkCalendar("microsoft_calendar", "Outlook Calendar")}
        />
      </div>
    </section>
  )
}

function ConnectionCard(props: {
  title: string
  description: string
  status: SettingsConnection["status"]
  children: JSX.Element
}) {
  return (
    <Card class={styles.connectionCard}>
      <CardHeader>
        <div class={styles.cardHeadingRow}>
          <div>
            <CardTitle>{props.title}</CardTitle>
            <CardDescription>{props.description}</CardDescription>
          </div>
          <Badge variant={statusVariant(props.status)}>{statusLabel(props.status)}</Badge>
        </div>
      </CardHeader>
      <CardContent>{props.children}</CardContent>
    </Card>
  )
}

function CalendarConnectionCard(props: {
  provider: ConnectionProvider
  label: string
  status: SettingsConnection["status"]
  linking: ConnectionProvider | undefined
  onLink: () => void
}) {
  return (
    <ConnectionCard
      title={props.label}
      description="Read schedules and create calendar events."
      status={props.status}
    >
      <p class={styles.hint}>
        {props.status === "connected"
          ? `${props.label} is linked to Bob.`
          : props.status === "unavailable"
            ? "Bob could not reach the connection service. Try again."
            : `Link ${props.label} when you want Bob to use this calendar.`}
      </p>
      <Button disabled={props.linking !== undefined} onClick={props.onLink}>
        {props.linking === props.provider
          ? "Creating private link…"
          : props.status === "connected"
            ? `Relink ${props.label}`
            : `Link ${props.label}`}
      </Button>
    </ConnectionCard>
  )
}

function MessageSettingsSection() {
  return (
    <section
      id="message-settings"
      class={styles.contentSection}
      aria-labelledby="message-settings-title"
    >
      <SectionHeader
        eyebrow="Sendblue controls"
        title="Change settings by message"
        id="message-settings-title"
      />
      <Card>
        <CardContent class={styles.messageExamples}>
          <p>Ask Bob about locality or give Bob a direct instruction. For example:</p>
          <ul>
            <li>“What time zone are you using?”</li>
            <li>“Set my time zone to America/New_York.”</li>
            <li>“Use 24-hour time.”</li>
          </ul>
          <p class={styles.hint}>Bob changes a setting only after a direct instruction.</p>
        </CardContent>
      </Card>
    </section>
  )
}

function SendblueHelpSection() {
  return (
    <section id="access-help" class={styles.contentSection} aria-labelledby="access-help-title">
      <SectionHeader eyebrow="Message delivery" title="Sendblue help" id="access-help-title" />
      <Card>
        <CardHeader>
          <CardTitle>Restart messages</CardTitle>
        </CardHeader>
        <CardContent>
          <p class={styles.messageExamples}>
            If messages stop after an opt-out, send <strong>START</strong> to the Bob number.
          </p>
          <p class={styles.hint}>Delivery does not mean that you saw or completed a reminder.</p>
        </CardContent>
      </Card>
    </section>
  )
}
