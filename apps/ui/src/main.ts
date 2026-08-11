import { DeviceLoginEvent } from "@bob/contracts/agent"
import {
  AlertList,
  AdminStatus,
  JournalEntry,
  JournalHandoff,
  JournalList,
  MemoryCandidateList,
  ReminderList,
  TrainingProposalList,
  type JournalMetadata,
  type MemoryCandidateReview,
  type OperationalAlert,
  type TrainingProposalReview
} from "@bob/contracts/ui"
import { Schema } from "effect"

declare const __BOB_API_BASE_URL__: string

const apiBase = __BOB_API_BASE_URL__

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id)
  if (value === null) throw new Error(`Missing interface element: ${id}`)
  return value as T
}

const pageStatus = element<HTMLDivElement>("page-status")
const reminderList = element<HTMLDivElement>("reminder-list")
const memoryList = element<HTMLDivElement>("memory-list")
const trainingList = element<HTMLDivElement>("training-list")
const journalList = element<HTMLDivElement>("journal-list")
const alertList = element<HTMLDivElement>("alert-list")
const authStatus = element<HTMLParagraphElement>("auth-status")
const deviceLogin = element<HTMLDivElement>("device-login")

function announce(message: string, error = false): void {
  pageStatus.textContent = message
  pageStatus.classList.toggle("error", error)
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method?.toUpperCase() ?? "GET"
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(method === "GET" || method === "HEAD" ? {} : { "idempotency-key": crypto.randomUUID() }),
      ...(init?.headers ?? {})
    }
  })
  const value = (await response.json()) as unknown
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
  return value
}

function emptyState(title: string, nextStep: string): HTMLElement {
  const card = document.createElement("div")
  card.className = "empty-state"
  const heading = document.createElement("p")
  heading.className = "empty-title"
  heading.textContent = title
  const detail = document.createElement("p")
  detail.textContent = nextStep
  card.append(heading, detail)
  return card
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "short"
  }).format(new Date(value))
}

async function loadReminders(): Promise<void> {
  reminderList.setAttribute("aria-busy", "true")
  try {
    const result = Schema.decodeUnknownSync(ReminderList)(await api("/api/reminders"))
    reminderList.replaceChildren()
    if (result.reminders.length === 0) {
      reminderList.append(emptyState("No active reminders", "Ask Bob in iMessage to set one."))
      return
    }
    for (const reminder of result.reminders) {
      const card = document.createElement("article")
      card.className = "panel reminder-card"
      const title = document.createElement("h3")
      title.textContent = reminder.displayText
      const time = document.createElement("p")
      time.className = "date"
      time.textContent =
        reminder.nextDueAt === undefined ? "No next date" : formatDate(reminder.nextDueAt)
      const state = document.createElement("p")
      state.className = "state"
      state.textContent = reminder.state === "paused" ? "Paused" : "Active"
      card.append(title, time, state)
      reminderList.append(card)
    }
  } catch {
    reminderList.replaceChildren(
      emptyState("Unable to load reminders", "Check your connection, then refresh reminders.")
    )
    announce("Unable to load reminders. Check your connection and try again.", true)
  } finally {
    reminderList.setAttribute("aria-busy", "false")
  }
}

function memoryCandidateCard(candidate: MemoryCandidateReview): HTMLElement {
  const card = document.createElement("article")
  card.className = "panel"
  const heading = document.createElement("h3")
  heading.textContent = candidate.canonicalText
  const identity = document.createElement("p")
  identity.className = "state"
  identity.textContent = `${candidate.scope} · ${candidate.key}`
  const source = document.createElement("p")
  source.className = "date"
  source.textContent = `Source: ${candidate.sourceType} · ${formatDate(candidate.createdAt)}`
  const sensitivity = document.createElement("p")
  sensitivity.className = "state"
  sensitivity.textContent = `Privacy: ${candidate.sensitivity}`
  const confirm = document.createElement("button")
  confirm.type = "button"
  confirm.textContent = "Confirm this memory"
  confirm.addEventListener("click", async () => {
    confirm.disabled = true
    try {
      await api(`/api/memory/candidates/${encodeURIComponent(candidate.id)}/confirm`, {
        method: "POST",
        headers: { "idempotency-key": `memory:${candidate.id}:confirm` },
        body: "{}"
      })
      announce("Memory confirmed with its source.")
      await loadMemoryCandidates()
    } catch {
      announce("Unable to confirm this memory. Review its source and try again.", true)
      confirm.disabled = false
    }
  })
  card.append(heading, identity, source, sensitivity, confirm)
  return card
}

async function loadMemoryCandidates(): Promise<void> {
  memoryList.setAttribute("aria-busy", "true")
  try {
    const result = Schema.decodeUnknownSync(MemoryCandidateList)(
      await api("/api/memory/candidates")
    )
    memoryList.replaceChildren()
    if (result.candidates.length === 0) {
      memoryList.append(emptyState("No memories need review", "New proposals will appear here."))
      return
    }
    memoryList.append(...result.candidates.map(memoryCandidateCard))
  } catch {
    memoryList.replaceChildren(
      emptyState("Unable to load memory candidates", "Check your connection, then refresh.")
    )
  } finally {
    memoryList.setAttribute("aria-busy", "false")
  }
}

const trainingLabels: Readonly<Record<TrainingProposalReview["toolName"], string>> = {
  gym_create: "Add gym",
  exercise_create: "Add exercise",
  gym_add_equipment: "Add gym equipment",
  equipment_map_exercise: "Map equipment to exercise",
  routine_save: "Save routine",
  workout_start: "Start workout",
  workout_log_set: "Log workout set",
  workout_finish: "Finish workout"
}

function trainingProposalCard(proposal: TrainingProposalReview): HTMLElement {
  const card = document.createElement("article")
  card.className = "panel"
  const heading = document.createElement("h3")
  heading.textContent = trainingLabels[proposal.toolName]
  const date = document.createElement("p")
  date.className = "date"
  date.textContent = formatDate(proposal.createdAt)
  const details = document.createElement("pre")
  details.className = "proposal-details"
  details.textContent = JSON.stringify(proposal.arguments, null, 2)
  const state = document.createElement("p")
  state.className = "state"
  state.textContent = `State: ${proposal.status}`
  card.append(heading, date, details, state)
  if (proposal.status === "proposed") {
    const approve = document.createElement("button")
    approve.type = "button"
    approve.textContent = "Approve this exact change"
    approve.addEventListener("click", async () => {
      approve.disabled = true
      try {
        await api(`/api/training/proposals/${encodeURIComponent(proposal.id)}/approve`, {
          method: "POST",
          headers: {
            "idempotency-key": `training:${proposal.id}:${proposal.proposalHash}`
          },
          body: JSON.stringify({ proposalHash: proposal.proposalHash })
        })
        announce("Training change applied.")
        await loadTrainingProposals()
      } catch {
        announce("Unable to apply this exact training change. Review it and try again.", true)
        approve.disabled = false
      }
    })
    card.append(approve)
  }
  return card
}

async function loadTrainingProposals(): Promise<void> {
  trainingList.setAttribute("aria-busy", "true")
  try {
    const result = Schema.decodeUnknownSync(TrainingProposalList)(
      await api("/api/training/proposals")
    )
    trainingList.replaceChildren()
    const pending = result.proposals.filter(
      (proposal) => proposal.status === "proposed" || proposal.status === "applying"
    )
    if (pending.length === 0) {
      trainingList.append(
        emptyState("No training changes need review", "New proposals will appear here.")
      )
      return
    }
    trainingList.append(...pending.map(trainingProposalCard))
  } catch {
    trainingList.replaceChildren(
      emptyState("Unable to load training changes", "Check your connection, then refresh.")
    )
  } finally {
    trainingList.setAttribute("aria-busy", "false")
  }
}

function journalCard(entry: JournalMetadata): HTMLElement {
  const card = document.createElement("article")
  card.className = "panel journal-card"
  const heading = document.createElement("h3")
  heading.textContent = formatDate(entry.createdAt)
  const tags = document.createElement("p")
  tags.className = "tags"
  tags.textContent = entry.tags.length === 0 ? "No tags" : entry.tags.join(" · ")
  card.append(heading, tags)
  if (entry.approvedSummary !== undefined) {
    const summary = document.createElement("p")
    summary.textContent = entry.approvedSummary
    card.append(summary)
  }

  const privateText = document.createElement("div")
  privateText.className = "private-text"
  privateText.hidden = true
  const actions = document.createElement("div")
  actions.className = "actions"
  const open = document.createElement("button")
  open.type = "button"
  open.className = "secondary"
  open.textContent = "Open private text"
  open.addEventListener("click", async () => {
    open.disabled = true
    try {
      const full = Schema.decodeUnknownSync(JournalEntry)(
        await api(`/api/journal/${encodeURIComponent(entry.id)}`)
      )
      privateText.textContent = full.text
      privateText.hidden = false
      open.textContent = "Private text opened"
    } catch {
      announce("Unable to open this entry. Check your connection and try again.", true)
      open.disabled = false
    }
  })
  const remove = document.createElement("button")
  remove.type = "button"
  remove.className = "danger"
  remove.textContent = "Delete entry"
  remove.addEventListener("click", async () => {
    if (!window.confirm("Delete this journal entry and its search data? This cannot be undone."))
      return
    remove.disabled = true
    try {
      await api(`/api/journal/${encodeURIComponent(entry.id)}`, { method: "DELETE" })
      announce("Journal entry deleted.")
      await loadJournal()
    } catch {
      announce("Unable to delete this entry. Check your connection and try again.", true)
      remove.disabled = false
    }
  })
  actions.append(open, remove)
  card.append(privateText, actions)
  return card
}

const alertLabels: Readonly<Record<OperationalAlert["code"], string>> = {
  inbound_exhausted: "A received message needs a safe retry.",
  delivery_uncertain: "A message delivery needs provider reconciliation.",
  delivery_result_exhausted: "A provider result reached its recovery queue.",
  agent_authentication_failed: "The Codex connection needs review.",
  reminder_missed: "A reminder passed its response deadline."
}

function alertCard(alert: OperationalAlert): HTMLElement {
  const card = document.createElement("article")
  card.className = "panel"
  const heading = document.createElement("h3")
  heading.textContent = alertLabels[alert.code]
  const date = document.createElement("p")
  date.className = "date"
  date.textContent = formatDate(alert.createdAt)
  const state = document.createElement("p")
  state.className = "state"
  state.textContent = `State: ${alert.state}`
  card.append(heading, date, state)
  if (alert.state !== "resolved") {
    const reconcile = document.createElement("button")
    reconcile.type = "button"
    reconcile.className = "secondary"
    reconcile.textContent = "Review safely"
    reconcile.addEventListener("click", async () => {
      reconcile.disabled = true
      try {
        await api(`/api/alerts/${encodeURIComponent(alert.id)}/reconcile`, {
          method: "POST",
          body: "{}"
        })
        announce("Alert review completed.")
        await loadAlerts()
      } catch {
        announce("Unable to review this alert. Check the service and try again.", true)
        reconcile.disabled = false
      }
    })
    card.append(reconcile)
  }
  return card
}

async function loadAlerts(): Promise<void> {
  alertList.setAttribute("aria-busy", "true")
  try {
    const result = Schema.decodeUnknownSync(AlertList)(await api("/api/alerts"))
    alertList.replaceChildren()
    const active = result.alerts.filter((alert) => alert.state !== "resolved")
    if (active.length === 0) {
      alertList.append(emptyState("No open alerts", "Bob has no item that needs your review."))
      return
    }
    alertList.append(...active.map(alertCard))
  } catch {
    alertList.replaceChildren(
      emptyState("Unable to load alerts", "Check your connection, then refresh alerts.")
    )
  } finally {
    alertList.setAttribute("aria-busy", "false")
  }
}

async function loadJournal(): Promise<void> {
  journalList.setAttribute("aria-busy", "true")
  try {
    const result = Schema.decodeUnknownSync(JournalList)(await api("/api/journal"))
    journalList.replaceChildren()
    if (result.entries.length === 0) {
      journalList.append(emptyState("No journal entries yet", "Use the form above to save one."))
      return
    }
    journalList.append(...result.entries.map(journalCard))
  } catch {
    journalList.replaceChildren(
      emptyState("Unable to load journal entries", "Check your connection, then refresh entries.")
    )
    announce("Unable to load journal entries. Check your connection and try again.", true)
  } finally {
    journalList.setAttribute("aria-busy", "false")
  }
}

function handoffFromPath(): string | undefined {
  const match = window.location.pathname.match(/^\/journal\/([0-9a-f-]{36})$/i)
  return match?.[1]
}

async function getHandoff(): Promise<string> {
  const existing = handoffFromPath()
  if (existing !== undefined) return existing
  const created = Schema.decodeUnknownSync(JournalHandoff)(
    await api("/api/journal/handoffs", { method: "POST", body: "{}" })
  )
  return created.id
}

async function saveJournal(event: SubmitEvent): Promise<void> {
  event.preventDefault()
  const form = event.currentTarget as HTMLFormElement
  const textArea = element<HTMLTextAreaElement>("journal-text")
  const error = element<HTMLParagraphElement>("journal-text-error")
  const submit = element<HTMLButtonElement>("save-journal")
  const text = textArea.value.trim()
  if (text.length === 0) {
    textArea.setAttribute("aria-invalid", "true")
    textArea.setAttribute("aria-describedby", "journal-text-hint journal-text-error")
    error.textContent = "Write something before you save the entry."
    error.hidden = false
    textArea.focus()
    return
  }
  textArea.removeAttribute("aria-invalid")
  textArea.setAttribute("aria-describedby", "journal-text-hint")
  error.hidden = true
  submit.disabled = true
  const label = submit.textContent
  submit.textContent = "Saving entry…"
  try {
    const tags = element<HTMLInputElement>("journal-tags")
      .value.split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
    const summary = element<HTMLInputElement>("journal-summary").value.trim()
    await api("/api/journal", {
      method: "POST",
      body: JSON.stringify({
        handoffId: await getHandoff(),
        text,
        tags,
        ...(summary.length === 0 ? {} : { approvedSummary: summary })
      })
    })
    form.reset()
    announce("Journal entry saved privately.")
    await loadJournal()
  } catch {
    announce("Unable to save this entry. Check your connection and try again.", true)
  } finally {
    submit.disabled = false
    submit.textContent = label
  }
}

async function loadAuth(): Promise<void> {
  try {
    const status = Schema.decodeUnknownSync(AdminStatus)(await api("/api/agent/status"))
    if (!status.configured) {
      authStatus.textContent = "Codex is not connected. Start login to connect it."
      return
    }
    const expiry =
      status.expiresAt === undefined ? "" : ` Credential expires ${formatDate(status.expiresAt)}.`
    authStatus.textContent = `Codex is connected${status.accountIdRedacted === undefined ? "" : ` to account ${status.accountIdRedacted}`}.${expiry}`
  } catch {
    authStatus.textContent = "Unable to check Codex access. Check the private agent service."
  }
}

async function startLogin(): Promise<void> {
  const button = element<HTMLButtonElement>("start-login")
  button.disabled = true
  const label = button.textContent
  button.textContent = "Starting login…"
  try {
    const event = Schema.decodeUnknownSync(DeviceLoginEvent)(
      await api("/api/agent/device-login", { method: "POST", body: "{}" })
    )
    deviceLogin.replaceChildren()
    deviceLogin.hidden = false
    if (event.type === "device_code") {
      const instruction = document.createElement("p")
      instruction.textContent = "Open the sign-in page and enter this code:"
      const code = document.createElement("output")
      code.textContent = event.userCode
      const link = document.createElement("a")
      link.href = event.verificationUri
      link.target = "_blank"
      link.rel = "noopener noreferrer"
      link.textContent = "Open the Codex sign-in page"
      const expiry = document.createElement("p")
      expiry.className = "hint"
      expiry.textContent = `Code expires ${formatDate(event.expiresAt)}.`
      deviceLogin.append(instruction, code, link, expiry)
    } else if (event.type === "completed") {
      deviceLogin.textContent = "Codex login completed."
      await loadAuth()
    } else {
      deviceLogin.textContent =
        "Unable to start login. Wait for any active login to finish, then try again."
    }
  } catch {
    announce("Unable to start Codex login. Check the private agent service and try again.", true)
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

element<HTMLFormElement>("journal-form").addEventListener("submit", saveJournal)
element<HTMLButtonElement>("refresh-reminders").addEventListener("click", loadReminders)
element<HTMLButtonElement>("refresh-memory").addEventListener("click", loadMemoryCandidates)
element<HTMLButtonElement>("refresh-training").addEventListener("click", loadTrainingProposals)
element<HTMLButtonElement>("refresh-journal").addEventListener("click", loadJournal)
element<HTMLButtonElement>("refresh-alerts").addEventListener("click", loadAlerts)
element<HTMLButtonElement>("refresh-auth").addEventListener("click", loadAuth)
element<HTMLButtonElement>("start-login").addEventListener("click", startLogin)

await Promise.all([
  loadReminders(),
  loadMemoryCandidates(),
  loadTrainingProposals(),
  loadJournal(),
  loadAlerts(),
  loadAuth()
])
