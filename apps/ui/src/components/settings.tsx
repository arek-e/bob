import {
  OwnerSettingsUpdate,
  OwnerSettingsView,
  type ConnectionProvider,
  type HourCycle,
  type SettingsConnection
} from "@bob/contracts/settings"
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

import { useStatus } from "~/components/app-shell"
import { useOwnerSession } from "~/components/auth"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Select } from "~/components/ui/select"
import { api, parseJson, schemas } from "~/lib/api"
import { styles } from "~/lib/styles"
import { cn, formatDate, supportedTimeZones } from "~/lib/utils"

type ClientProps = { enabled: Accessor<boolean> }

const settingsSections = [
  { id: "locality", label: "General" },
  { id: "connections", label: "Connections" },
  { id: "message-settings", label: "Messaging" },
  { id: "access-help", label: "Delivery" }
] as const

type SettingsSectionId = (typeof settingsSections)[number]["id"]

const DeviceLoginEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("device_code"),
    verificationUri: Schema.String,
    userCode: Schema.String,
    expiresAt: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("completed"),
    accountIdRedacted: Schema.String,
    expiresAt: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    code: Schema.String
  })
])

type DeviceLoginEventType = typeof DeviceLoginEvent.Type

const AdminStatus = Schema.Struct({
  configured: Schema.Boolean,
  provider: Schema.String,
  expiresAt: Schema.optionalKey(Schema.String),
  accountIdRedacted: Schema.optionalKey(Schema.String)
})

function SectionHeader(props: {
  title: string
  description: string
  id: string
  action?: JSX.Element
}) {
  return (
    <div class={styles.sectionHeading}>
      <div class={styles.sectionHeadingCopy}>
        <h2 class={styles.sectionTitle} id={props.id}>
          {props.title}
        </h2>
        <p class={styles.sectionIntro}>{props.description}</p>
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
  const [activeSection, setActiveSection] = createSignal<SettingsSectionId>(sectionFromHash())

  onMount(() => {
    setEnabled(true)
    const syncSection = () => setActiveSection(sectionFromHash())
    window.addEventListener("hashchange", syncSection)
    onCleanup(() => window.removeEventListener("hashchange", syncSection))
  })

  return (
    <>
      <nav class={styles.settingsNav} aria-label="Settings sections">
        <ul class={styles.settingsNavList}>
          <For each={settingsSections}>
            {(section) => (
              <li>
                <a
                  class={cn(
                    styles.settingsNavLink,
                    activeSection() === section.id && styles.settingsNavLinkActive
                  )}
                  href={`#${section.id}`}
                  aria-current={activeSection() === section.id ? "location" : undefined}
                >
                  {section.label}
                </a>
              </li>
            )}
          </For>
        </ul>
      </nav>
      <div class={styles.settingsContent}>
        <div class={styles.settingsStack}>
          <div hidden={activeSection() !== "locality"}>
            <LocalitySection enabled={enabled} />
          </div>
          <div hidden={activeSection() !== "connections"}>
            <ConnectionsSection enabled={enabled} />
          </div>
          <div hidden={activeSection() !== "message-settings"}>
            <MessageSettingsSection />
          </div>
          <div hidden={activeSection() !== "access-help"}>
            <SendblueHelpSection />
          </div>
        </div>
      </div>
    </>
  )
}

function sectionFromHash(): SettingsSectionId {
  if (typeof window === "undefined") return "locality"
  const hash = window.location.hash.slice(1)
  return settingsSections.some((section) => section.id === hash)
    ? (hash as SettingsSectionId)
    : "locality"
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
  let timeZoneField: HTMLSelectElement | undefined
  let localeField: HTMLInputElement | undefined

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
      timeZoneField?.focus()
      return
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: timeZone() }).format()
    } catch {
      setTimeZoneError("Choose a valid time zone.")
      timeZoneField?.focus()
      return
    }

    let canonicalLocale: string
    try {
      const [canonical] = Intl.getCanonicalLocales(locale().trim())
      if (canonical === undefined) throw new Error("Locale is empty")
      canonicalLocale = canonical
    } catch {
      setLocaleError("Use a valid language and region code, such as en-SE.")
      localeField?.focus()
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
      <form
        class={styles.formCard}
        aria-labelledby="locality-title"
        aria-describedby="locality-description"
        novalidate
        onSubmit={(event) => void save(event)}
      >
        <div class={styles.formCardHeader}>
          <h2 id="locality-title" class={styles.sectionTitle}>
            Local time and language
          </h2>
          <p id="locality-description" class={styles.formIntro}>
            Bob uses these settings for new reminders, replies, and calendar dates.
          </p>
        </div>
        <div class={styles.formCardContent}>
          <div class={styles.formFields}>
            <div class={styles.fieldGroup}>
              <label class={styles.fieldLabel} for="settings-time-zone">
                Time zone
              </label>
              <Select
                ref={(element) => (timeZoneField = element)}
                id="settings-time-zone"
                name="timeZone"
                required
                value={timeZone()}
                aria-describedby={
                  timeZoneError().length > 0
                    ? "settings-time-zone-hint settings-time-zone-error"
                    : "settings-time-zone-hint"
                }
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
                ref={(element) => (localeField = element)}
                id="settings-locale"
                name="locale"
                list="settings-locale-options"
                placeholder="en-SE"
                spellcheck="false"
                required
                value={locale()}
                aria-describedby={
                  localeError().length > 0
                    ? "settings-locale-hint settings-locale-error"
                    : "settings-locale-hint"
                }
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
          </div>
        </div>
        <div class={styles.formCardFooter}>
          <div class={styles.footerCopy}>
            <p class={styles.footerTitle}>Existing reminders stay unchanged</p>
            <p class={styles.footerText}>
              A new time zone applies to future requests. Existing reminders keep their saved date,
              time, and time zone.
            </p>
          </div>
          <Button class="w-full sm:w-auto" type="submit" disabled={saving()}>
            {saving() ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
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
    const popup = window.open("about:blank", "_blank")
    if (popup !== null) popup.opener = null
    setLinking(provider)
    try {
      const session = parseJson(
        schemas.connectionSession,
        await api(`/api/connections/${provider}/session`, { method: "POST", body: "{}" })
      )
      if (popup === null) window.location.assign(session.connectUrl)
      else popup.location.replace(session.connectUrl)
      status.announce(`Finish linking ${label} in the new window.`)
    } catch {
      popup?.close()
      status.announce(`Unable to link ${label}. Try again.`, true)
    } finally {
      setLinking(undefined)
    }
  }

  return (
    <section id="connections" class={styles.contentSection} aria-labelledby="connections-title">
      <SectionHeader
        title="Accounts and connections"
        description="Link each service once. Bob will use the linked account when a task needs it."
        id="connections-title"
        action={
          <Button variant="secondary" disabled={refreshing()} onClick={() => void refresh()}>
            {refreshing() ? "Refreshing…" : "Refresh connections"}
          </Button>
        }
      />
      <div class={styles.connectionGrid}>
        <ConnectionCard
          title="Bob owner account"
          description="Controls access to Bob settings."
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
      <CardContent class={styles.connectionCardContent}>{props.children}</CardContent>
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
      <Button
        class="justify-self-start"
        disabled={props.linking !== undefined}
        onClick={props.onLink}
      >
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
        title="Change settings by message"
        description="Use the same direct language in iMessage that you use on this page."
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
      <SectionHeader
        title="Sendblue help"
        description="Recover message delivery without changing Bob's reminder records."
        id="access-help-title"
      />
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
