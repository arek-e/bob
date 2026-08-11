import {
  AlertList,
  JournalEntry,
  JournalHandoff,
  JournalList,
  MemoryCandidateList,
  ReminderList,
  TrainingOverview,
  TrainingProposalList
} from "@bob/contracts/ui"
import type {
  JournalEntry as JournalEntryView,
  JournalMetadata,
  MemoryCandidateReview,
  OperationalAlert,
  ReminderSummary,
  TrainingOverview as TrainingOverviewView,
  TrainingProposalReview
} from "@bob/contracts/ui"
import { Schema } from "effect"
import {
  createEffect,
  createResource,
  createSignal,
  For,
  onMount,
  Show,
  type Accessor,
  type JSX
} from "solid-js"

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
import { EmptyState } from "~/components/ui/empty-state"
import { Input } from "~/components/ui/input"
import { Notice } from "~/components/ui/notice"
import { Textarea } from "~/components/ui/textarea"
import { api, parseJson, schemas } from "~/lib/api"
import { cn, formatDate, formatDateInTimeZone, parseTags } from "~/lib/utils"
import { styles } from "~/lib/styles"
import { journalIndexMarkdown } from "~/journal-export"

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

function LoadingState() {
  return (
    <div class={styles.loadingState} role="status" aria-live="polite">
      Loading…
    </div>
  )
}

function DashboardIntro() {
  return (
    <header class={styles.pageIntro}>
      <div class={styles.introCopy}>
        <p class={styles.eyebrow}>Overview</p>
        <h1 class={styles.heading1}>Good to see you.</h1>
        <p class={styles.introText}>
          Keep the important parts of your day close. Review what Bob has saved or flagged.
        </p>
      </div>
      <nav class={styles.sectionNav} aria-label="Dashboard sections">
        <a class={styles.sectionNavLink} href="#reminders">
          Reminders
        </a>
        <a class={styles.sectionNavLink} href="#memory">
          Memory
        </a>
        <a class={styles.sectionNavLink} href="#training">
          Training
        </a>
        <a class={styles.sectionNavLink} href="#journal">
          Journal
        </a>
        <a class={styles.sectionNavLink} href="#alerts">
          Alerts
        </a>
      </nav>
    </header>
  )
}

export function DashboardPage() {
  const [enabled, setEnabled] = createSignal(false)
  onMount(() => setEnabled(true))

  return (
    <>
      <DashboardIntro />
      <div class={styles.dashboardStack}>
        <ReminderSection enabled={enabled} />
        <MemorySection enabled={enabled} />
        <TrainingSection enabled={enabled} />
        <JournalSection enabled={enabled} />
        <AlertsSection enabled={enabled} />
      </div>
    </>
  )
}

function ReminderSection(props: ClientProps) {
  const status = useStatus()
  const [reminders, { refetch }] = createResource(
    () => (props.enabled() ? "ready" : undefined),
    async () => parseJson(ReminderList, await api("/api/reminders")).reminders
  )
  const [refreshing, setRefreshing] = createSignal(false)

  async function refresh() {
    setRefreshing(true)
    try {
      await refetch()
    } catch {
      status.announce("Unable to load reminders. Check your connection and try again.", true)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section id="reminders" class={styles.contentSection} aria-labelledby="reminders-title">
      <SectionHeader
        eyebrow="Today and later"
        title="Reminders"
        id="reminders-title"
        action={
          <Button variant="secondary" disabled={refreshing()} onClick={() => void refresh()}>
            {refreshing() ? "Refreshing…" : "Refresh reminders"}
          </Button>
        }
      />
      <Notice tone="info">
        <strong>One-time reminders only.</strong> Recurring reminder creation is not ready yet.
      </Notice>
      <div class={styles.cardGrid} aria-busy={reminders.loading}>
        <Show when={!reminders.loading} fallback={<LoadingState />}>
          <Show
            when={(reminders() ?? []).length > 0}
            fallback={
              <EmptyState title="No active reminders" detail="Ask Bob in iMessage to set one." />
            }
          >
            <For each={reminders()}>
              {(reminder) => <ReminderCard reminder={reminder} refresh={refetch} />}
            </For>
          </Show>
        </Show>
      </div>
    </section>
  )
}

function ReminderCard(props: { reminder: ReminderSummary; refresh: () => unknown }) {
  const status = useStatus()
  const [busy, setBusy] = createSignal(false)
  const reminder = () => props.reminder
  const target = () => reminder().actionTargets[0]

  async function action(actionName: "seen" | "done" | "snooze") {
    const occurrence = target()
    if (occurrence === undefined) return
    setBusy(true)
    try {
      await api(
        `/api/reminder-occurrences/${encodeURIComponent(occurrence.occurrenceId)}/${actionName}`,
        {
          method: "POST",
          headers: { "idempotency-key": `reminder:${occurrence.occurrenceId}:${actionName}` },
          body:
            actionName === "snooze"
              ? JSON.stringify({ dueAt: new Date(Date.now() + 15 * 60_000).toISOString() })
              : "{}"
        }
      )
      status.announce(
        actionName === "seen"
          ? "Reminder marked as seen."
          : actionName === "done"
            ? "Reminder marked as done."
            : "Reminder snoozed for 15 minutes."
      )
      await props.refresh()
    } catch {
      status.announce("Unable to update this reminder. Refresh it and try again.", true)
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    if (
      !window.confirm(
        `Cancel “${reminder().displayText}”? Bob will stop all future messages for this reminder.`
      )
    )
      return
    setBusy(true)
    try {
      await api(`/api/reminders/${encodeURIComponent(reminder().id)}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": `reminder:${reminder().id}:cancel` },
        body: "{}"
      })
      status.announce("Reminder cancelled.")
      await props.refresh()
    } catch {
      status.announce("Unable to cancel this reminder. Refresh it and try again.", true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div class={styles.cardHeadingRow}>
          <CardTitle>{reminder().displayText}</CardTitle>
          <Badge variant={reminder().state === "active" ? "success" : "warning"}>
            {reminder().state === "active" ? "Active" : "Paused"}
          </Badge>
        </div>
        <CardDescription>
          {reminder().nextDueAt === undefined
            ? "No next date"
            : `${formatDateInTimeZone(reminder().nextDueAt!, reminder().timeZone)} · ${reminder().timeZone}`}
        </CardDescription>
      </CardHeader>
      <CardFooter class={styles.actionRow}>
        <Show when={target()?.state === "awaiting_response"}>
          <Button variant="secondary" disabled={busy()} onClick={() => void action("seen")}>
            Mark seen
          </Button>
        </Show>
        <Show when={target()?.state === "awaiting_response" || target()?.state === "acknowledged"}>
          <Button disabled={busy()} onClick={() => void action("done")}>
            Mark done
          </Button>
          <Button variant="secondary" disabled={busy()} onClick={() => void action("snooze")}>
            Snooze 15 min
          </Button>
        </Show>
        <Button variant="danger" disabled={busy()} onClick={() => void cancel()}>
          Cancel
        </Button>
      </CardFooter>
    </Card>
  )
}

function MemorySection(props: ClientProps) {
  const status = useStatus()
  const [candidates, { refetch }] = createResource(
    () => (props.enabled() ? "ready" : undefined),
    async () => parseJson(MemoryCandidateList, await api("/api/memory/candidates")).candidates
  )
  const [refreshing, setRefreshing] = createSignal(false)

  async function refresh() {
    setRefreshing(true)
    try {
      await refetch()
    } catch {
      status.announce(
        "Unable to load memory candidates. Check your connection and try again.",
        true
      )
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section id="memory" class={styles.contentSection} aria-labelledby="memory-title">
      <SectionHeader
        eyebrow="Owner review"
        title="Memory candidates"
        id="memory-title"
        action={
          <Button variant="secondary" disabled={refreshing()} onClick={() => void refresh()}>
            {refreshing() ? "Refreshing…" : "Refresh memories"}
          </Button>
        }
      />
      <Notice tone="warning">
        <strong>Nothing becomes a fact without your approval.</strong> Each proposal keeps its
        source.
      </Notice>
      <div class={styles.cardGrid} aria-busy={candidates.loading}>
        <Show when={!candidates.loading} fallback={<LoadingState />}>
          <Show
            when={(candidates() ?? []).length > 0}
            fallback={
              <EmptyState
                title="No memories need review"
                detail="New proposals will appear here."
              />
            }
          >
            <For each={candidates()}>
              {(candidate) => <MemoryCard candidate={candidate} refresh={refetch} />}
            </For>
          </Show>
        </Show>
      </div>
    </section>
  )
}

function MemoryCard(props: { candidate: MemoryCandidateReview; refresh: () => unknown }) {
  const status = useStatus()
  const [busy, setBusy] = createSignal(false)
  const [correction, setCorrection] = createSignal(props.candidate.canonicalText)

  async function review(actionName: "confirm" | "reject") {
    if (
      actionName === "reject" &&
      !window.confirm("Reject this memory? Bob will not save this proposal as a fact.")
    )
      return
    setBusy(true)
    try {
      await api(`/api/memory/candidates/${encodeURIComponent(props.candidate.id)}/${actionName}`, {
        method: "POST",
        headers: { "idempotency-key": `memory:${props.candidate.id}:${actionName}` },
        body: "{}"
      })
      status.announce(
        actionName === "confirm" ? "Memory confirmed with its source." : "Memory rejected."
      )
      await props.refresh()
    } catch {
      status.announce("Unable to review this memory. Check its source and try again.", true)
    } finally {
      setBusy(false)
    }
  }

  async function saveCorrection(event: SubmitEvent) {
    event.preventDefault()
    const value = correction().trim()
    if (value.length === 0) {
      status.announce("Write the corrected memory before you save it.", true)
      return
    }
    setBusy(true)
    try {
      await api(`/api/memory/candidates/${encodeURIComponent(props.candidate.id)}/correct`, {
        method: "POST",
        headers: { "idempotency-key": `memory:${props.candidate.id}:correct` },
        body: JSON.stringify({ canonicalText: value })
      })
      status.announce("Correction saved. Confirm the corrected memory next.")
      await props.refresh()
    } catch {
      status.announce("Unable to save this correction. Check the source and try again.", true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div class={styles.cardHeadingRow}>
          <CardTitle>{props.candidate.canonicalText}</CardTitle>
          <Badge variant={props.candidate.sensitivity === "high" ? "danger" : "neutral"}>
            {props.candidate.sensitivity} privacy
          </Badge>
        </div>
        <CardDescription>
          {props.candidate.scope} · {props.candidate.key} · Source: {props.candidate.sourceLabel}
        </CardDescription>
      </CardHeader>
      <CardFooter class={styles.actionRow}>
        <Show when={props.candidate.originClass === "owner_input"}>
          <Button disabled={busy()} onClick={() => void review("confirm")}>
            Confirm memory
          </Button>
        </Show>
        <Button variant="danger" disabled={busy()} onClick={() => void review("reject")}>
          Reject memory
        </Button>
      </CardFooter>
      <Show
        when={props.candidate.originClass === "owner_input"}
        fallback={<p class={styles.hint}>Reject this item if the saved system record is wrong.</p>}
      >
        <details class={styles.detailsPanel}>
          <summary>Correct this memory</summary>
          <form class={styles.inlineForm} onSubmit={(event) => void saveCorrection(event)}>
            <label class={styles.fieldLabel} for={`memory-correction-${props.candidate.id}`}>
              Correct memory text
            </label>
            <Textarea
              id={`memory-correction-${props.candidate.id}`}
              rows="3"
              maxlength="8000"
              required
              value={correction()}
              onInput={(event) => setCorrection(event.currentTarget.value)}
            />
            <p class={styles.hint}>
              The correction stays bound to {props.candidate.sourceLabel.toLowerCase()}.
            </p>
            <Button type="submit" disabled={busy()}>
              Save correction for review
            </Button>
          </form>
        </details>
      </Show>
    </Card>
  )
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

const workoutStatusLabels: Readonly<
  Record<TrainingOverviewView["history"][number]["status"], string>
> = {
  active: "Active",
  completed: "Completed",
  stopped_for_safety: "Stopped for safety",
  abandoned: "Not finished"
}

function TrainingSection(props: ClientProps) {
  const status = useStatus()
  const [query, setQuery] = createSignal("")
  const [requestedQuery, setRequestedQuery] = createSignal("")
  const [overview, { refetch: refetchOverview }] = createResource(
    () => (props.enabled() ? requestedQuery() : undefined),
    async (search) => {
      const value = search.trim()
      const suffix = value.length === 0 ? "" : `?q=${encodeURIComponent(value)}`
      return parseJson(TrainingOverview, await api(`/api/training/overview${suffix}`))
    }
  )
  const [proposals, { refetch: refetchProposals }] = createResource(
    () => (props.enabled() ? "ready" : undefined),
    async () => parseJson(TrainingProposalList, await api("/api/training/proposals")).proposals
  )
  const [refreshing, setRefreshing] = createSignal(false)

  async function refresh() {
    setRefreshing(true)
    try {
      await Promise.all([refetchOverview(), refetchProposals()])
    } catch {
      status.announce("Unable to load training records. Check your connection and try again.", true)
    } finally {
      setRefreshing(false)
    }
  }

  function submitSearch(event: SubmitEvent) {
    event.preventDefault()
    setRequestedQuery(query().trim())
    status.announce(
      query().trim().length === 0 ? "Training records refreshed." : "Training search complete."
    )
  }

  function clearSearch() {
    setQuery("")
    setRequestedQuery("")
    status.announce("Training search cleared.")
  }

  return (
    <section id="training" class={styles.contentSection} aria-labelledby="training-title">
      <SectionHeader
        eyebrow="Your saved plan"
        title="Training"
        id="training-title"
        action={
          <Button variant="secondary" disabled={refreshing()} onClick={() => void refresh()}>
            {refreshing() ? "Refreshing…" : "Refresh training"}
          </Button>
        }
      />
      <Notice tone="info">
        <strong>Your approved plan, in one place.</strong> New changes still need your exact
        approval.
      </Notice>
      <form class={styles.searchPanel} role="search" onSubmit={(event) => submitSearch(event)}>
        <div>
          <label class={styles.fieldLabel} for="training-search">
            Search training records
          </label>
          <Input
            id="training-search"
            name="q"
            type="search"
            maxlength="100"
            placeholder="Gym, machine, exercise, or routine"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <div class={styles.actionRow}>
          <Button type="submit">Search training</Button>
          <Button type="button" variant="secondary" onClick={clearSearch}>
            Clear search
          </Button>
        </div>
      </form>
      <Show when={overview.loading || proposals.loading}>
        <LoadingState />
      </Show>
      <Show when={overview()}>{(value) => <TrainingOverviewContent overview={value()} />}</Show>
      <div class={styles.trainingGroup}>
        <div class={styles.subsectionHeading}>
          <h3 class={styles.subsectionTitle}>Changes awaiting approval</h3>
          <span class={styles.subsectionRule} />
        </div>
        <div class={styles.cardGrid} aria-busy={proposals.loading}>
          <Show
            when={
              (proposals() ?? []).filter(
                (proposal) => proposal.status === "proposed" || proposal.status === "applying"
              ).length > 0
            }
            fallback={
              <EmptyState
                title="No training changes need review"
                detail="New proposals will appear here."
              />
            }
          >
            <For
              each={(proposals() ?? []).filter(
                (proposal) => proposal.status === "proposed" || proposal.status === "applying"
              )}
            >
              {(proposal) => (
                <TrainingProposalCard proposal={proposal} refresh={refetchProposals} />
              )}
            </For>
          </Show>
        </div>
      </div>
    </section>
  )
}

function TrainingOverviewContent(props: { overview: TrainingOverviewView }) {
  const overview = () => props.overview
  return (
    <div class={styles.trainingOverview}>
      <TrainingGroup title="Active workout">
        <Show
          when={overview().activeWorkout !== undefined}
          fallback={
            <EmptyState title="No active workout" detail="Ask Bob to start an approved routine." />
          }
        >
          <Card>
            <CardHeader>
              <CardTitle>{overview().activeWorkout?.routineName}</CardTitle>
              <CardDescription>
                Started {formatDate(overview().activeWorkout!.startedAt)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p>
                {overview().activeWorkout!.sets.length}{" "}
                {overview().activeWorkout!.sets.length === 1 ? "set" : "sets"} logged.
              </p>
              <NamedList
                items={overview().activeWorkout!.sets.map((set) => {
                  const weight =
                    set.weightGrams === null
                      ? ""
                      : ` at ${(set.weightGrams / 1_000).toLocaleString()} kg`
                  return `Set ${set.sequence}: ${set.repetitions} repetitions${weight}`
                })}
                emptyText="No sets logged."
              />
            </CardContent>
          </Card>
        </Show>
      </TrainingGroup>
      <TrainingGroup title="Gyms and equipment">
        <Show
          when={overview().gyms.length > 0}
          fallback={
            <EmptyState
              title="No matching gyms"
              detail="Try another search or ask Bob to add a gym."
            />
          }
        >
          <For each={overview().gyms}>
            {(gym) => (
              <Card>
                <CardHeader>
                  <CardTitle>{gym.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <NamedList
                    items={gym.equipment.map((item) =>
                      item.identifier === null ? item.name : `${item.name} · ${item.identifier}`
                    )}
                    emptyText="No equipment saved for this gym."
                  />
                </CardContent>
              </Card>
            )}
          </For>
        </Show>
      </TrainingGroup>
      <TrainingGroup title="Exercises">
        <Show
          when={overview().exercises.length > 0}
          fallback={<EmptyState title="No matching exercises" detail="Try another search." />}
        >
          <For each={overview().exercises}>
            {(exercise) => (
              <Card>
                <CardHeader>
                  <CardTitle>{exercise.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p>{exercise.instructions ?? "No instructions saved."}</p>
                </CardContent>
              </Card>
            )}
          </For>
        </Show>
      </TrainingGroup>
      <TrainingGroup title="Routines">
        <Show
          when={overview().routines.length > 0}
          fallback={
            <EmptyState
              title="No matching routines"
              detail="Try another search or ask Bob to save one."
            />
          }
        >
          <For each={overview().routines}>
            {(routine) => (
              <Card>
                <CardHeader>
                  <CardTitle>{routine.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <NamedList
                    items={routine.steps.map((step) => {
                      const targets = [
                        step.targetSets === null ? undefined : `${step.targetSets} sets`,
                        step.targetReps === null ? undefined : `${step.targetReps} repetitions`
                      ].filter((value): value is string => value !== undefined)
                      return targets.length === 0
                        ? step.exerciseName
                        : `${step.exerciseName} · ${targets.join(" · ")}`
                    })}
                    emptyText="No steps saved."
                  />
                </CardContent>
              </Card>
            )}
          </For>
        </Show>
      </TrainingGroup>
      <TrainingGroup title="Workout history">
        <Show
          when={overview().history.length > 0}
          fallback={
            <EmptyState title="No workout history" detail="Completed workouts will appear here." />
          }
        >
          <For each={overview().history}>
            {(workout) => (
              <Card>
                <CardHeader>
                  <CardTitle>{workout.routineName}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p class={styles.date}>{formatDate(workout.startedAt)}</p>
                  <Badge variant={workout.status === "completed" ? "success" : "neutral"}>
                    {workoutStatusLabels[workout.status]}
                  </Badge>
                </CardContent>
              </Card>
            )}
          </For>
        </Show>
      </TrainingGroup>
    </div>
  )
}

function TrainingGroup(props: { title: string; children: JSX.Element }) {
  return (
    <div class={styles.trainingGroup}>
      <div class={styles.subsectionHeading}>
        <h3 class={styles.subsectionTitle}>{props.title}</h3>
        <span class={styles.subsectionRule} />
      </div>
      <div class={styles.cardGrid}>{props.children}</div>
    </div>
  )
}

function NamedList(props: { items: readonly string[]; emptyText: string }) {
  return props.items.length === 0 ? (
    <p class={styles.hint}>{props.emptyText}</p>
  ) : (
    <ul class={styles.detailList}>
      <For each={props.items}>{(item) => <li>{item}</li>}</For>
    </ul>
  )
}

function TrainingProposalCard(props: { proposal: TrainingProposalReview; refresh: () => unknown }) {
  const status = useStatus()
  const [busy, setBusy] = createSignal(false)
  async function approve() {
    setBusy(true)
    try {
      await api(`/api/training/proposals/${encodeURIComponent(props.proposal.id)}/approve`, {
        method: "POST",
        headers: {
          "idempotency-key": `training:${props.proposal.id}:${props.proposal.proposalHash}`
        },
        body: JSON.stringify({ proposalHash: props.proposal.proposalHash })
      })
      status.announce("Training change applied.")
      await props.refresh()
    } catch {
      status.announce("Unable to apply this exact training change. Review it and try again.", true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div class={styles.cardHeadingRow}>
          <CardTitle>{trainingLabels[props.proposal.toolName]}</CardTitle>
          <Badge variant={props.proposal.status === "applying" ? "warning" : "info"}>
            {props.proposal.status}
          </Badge>
        </div>
        <CardDescription>{formatDate(props.proposal.createdAt)}</CardDescription>
      </CardHeader>
      <CardContent>
        <pre class={styles.proposalDetails}>
          {JSON.stringify(props.proposal.arguments, null, 2)}
        </pre>
      </CardContent>
      <Show when={props.proposal.status === "proposed"}>
        <CardFooter>
          <Button disabled={busy()} onClick={() => void approve()}>
            {busy() ? "Applying…" : "Approve this exact change"}
          </Button>
        </CardFooter>
      </Show>
    </Card>
  )
}

function JournalSection(props: ClientProps) {
  const status = useStatus()
  const [entries, { refetch }] = createResource(
    () => (props.enabled() ? "ready" : undefined),
    async () => parseJson(JournalList, await api("/api/journal")).entries
  )
  const [text, setText] = createSignal("")
  const [tags, setTags] = createSignal("")
  const [summary, setSummary] = createSignal("")
  const [textError, setTextError] = createSignal("")
  const [tagsError, setTagsError] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)

  async function save(event: SubmitEvent) {
    event.preventDefault()
    const value = text().trim()
    const tagValues = parseTags(tags())
    setTextError(value.length === 0 ? "Write something before you save the entry." : "")
    setTagsError(tagValues.length > 25 ? "Use 25 tags or fewer." : "")
    if (value.length === 0 || tagValues.length > 25) return

    setSaving(true)
    try {
      const handoff = parseJson(
        JournalHandoff,
        await api("/api/journal/handoffs", { method: "POST", body: "{}" })
      )
      await api("/api/journal", {
        method: "POST",
        body: JSON.stringify({
          handoffId: handoff.id,
          text: value,
          tags: tagValues,
          ...(summary().trim().length === 0 ? {} : { approvedSummary: summary().trim() })
        })
      })
      setText("")
      setTags("")
      setSummary("")
      status.announce("Journal entry saved privately.")
      await refetch()
    } catch {
      status.announce("Unable to save this entry. Check your connection and try again.", true)
    } finally {
      setSaving(false)
    }
  }

  async function refresh() {
    setRefreshing(true)
    try {
      await refetch()
    } catch {
      status.announce("Unable to load journal entries. Check your connection and try again.", true)
    } finally {
      setRefreshing(false)
    }
  }

  function exportIndex() {
    const value = entries() ?? []
    if (value.length === 0) {
      status.announce("There are no journal entries to export.")
      return
    }
    if (
      !window.confirm(
        "Export an Obsidian Markdown index with dates, tags, and approved summaries? Private journal text stays in Bob."
      )
    )
      return
    const blob = new Blob([journalIndexMarkdown(value, new Date().toISOString())], {
      type: "text/markdown;charset=utf-8"
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `bob-journal-index-${new Date().toISOString().slice(0, 10)}.md`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    status.announce("Journal index exported. Private journal text was not included.")
  }

  return (
    <section id="journal" class={styles.contentSection} aria-labelledby="journal-title">
      <SectionHeader eyebrow="Private by default" title="Journal" id="journal-title" />
      <Notice tone="info">
        <strong>Your text stays here.</strong> Bob does not send journal text through iMessage or to
        the agent.
      </Notice>
      <form class={styles.formCard} novalidate onSubmit={(event) => void save(event)}>
        <div class={styles.fieldGroup}>
          <label class={styles.fieldLabel} for="journal-text">
            What do you want to remember?
          </label>
          <Textarea
            id="journal-text"
            name="text"
            rows="8"
            maxlength="8000"
            required
            value={text()}
            aria-describedby="journal-text-hint journal-text-error"
            aria-invalid={textError().length > 0}
            onInput={(event) => {
              setText(event.currentTarget.value)
              setTextError("")
            }}
          />
          <p id="journal-text-hint" class={styles.hint}>
            Write as much or as little as you need.
          </p>
          <Show when={textError().length > 0}>
            <p id="journal-text-error" class={styles.fieldError}>
              {textError()}
            </p>
          </Show>
        </div>
        <div class={styles.fieldGroup}>
          <label class={styles.fieldLabel} for="journal-tags">
            Tags
          </label>
          <Input
            id="journal-tags"
            name="tags"
            maxlength="1200"
            placeholder="training, family"
            value={tags()}
            aria-describedby="journal-tags-hint journal-tags-error"
            aria-invalid={tagsError().length > 0}
            onInput={(event) => {
              setTags(event.currentTarget.value)
              setTagsError("")
            }}
          />
          <p id="journal-tags-hint" class={styles.hint}>
            Separate tags with commas.
          </p>
          <Show when={tagsError().length > 0}>
            <p id="journal-tags-error" class={styles.fieldError}>
              {tagsError()}
            </p>
          </Show>
        </div>
        <div class={styles.fieldGroup}>
          <label class={styles.fieldLabel} for="journal-summary">
            Summary for your journal index (optional)
          </label>
          <Input
            id="journal-summary"
            maxlength="500"
            value={summary()}
            onInput={(event) => setSummary(event.currentTarget.value)}
          />
          <p class={styles.hint}>
            This summary stays in your private journal list and approved export.
          </p>
        </div>
        <Button type="submit" disabled={saving()}>
          {saving() ? "Saving entry…" : "Save journal entry"}
        </Button>
      </form>
      <div class={cn(styles.sectionHeading, styles.subsectionHeadingSpaced)}>
        <h3 class={styles.heading3}>Saved entries</h3>
        <div class={styles.actionRow}>
          <Button variant="secondary" onClick={exportIndex}>
            Export approved index
          </Button>
          <Button variant="secondary" disabled={refreshing()} onClick={() => void refresh()}>
            {refreshing() ? "Refreshing…" : "Refresh entries"}
          </Button>
        </div>
      </div>
      <div class={styles.cardGrid} aria-busy={entries.loading}>
        <Show when={!entries.loading} fallback={<LoadingState />}>
          <Show
            when={(entries() ?? []).length > 0}
            fallback={
              <EmptyState title="No journal entries yet" detail="Use the form above to save one." />
            }
          >
            <For each={entries()}>{(entry) => <JournalCard entry={entry} refresh={refetch} />}</For>
          </Show>
        </Show>
      </div>
    </section>
  )
}

function JournalCard(props: { entry: JournalMetadata; refresh: () => unknown }) {
  const status = useStatus()
  const [fullEntry, setFullEntry] = createSignal<JournalEntryView>()
  const [editing, setEditing] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [editText, setEditText] = createSignal("")
  const [editTags, setEditTags] = createSignal("")
  const [editSummary, setEditSummary] = createSignal("")

  async function loadFull() {
    const existing = fullEntry()
    if (existing !== undefined) return existing
    const value = parseJson(
      JournalEntry,
      await api(`/api/journal/${encodeURIComponent(props.entry.id)}`)
    )
    setFullEntry(value)
    return value
  }

  async function openText() {
    setBusy(true)
    try {
      await loadFull()
    } catch {
      status.announce("Unable to open this entry. Check your connection and try again.", true)
    } finally {
      setBusy(false)
    }
  }

  async function startEditing() {
    setBusy(true)
    try {
      const entry = await loadFull()
      setEditText(entry.text)
      setEditTags(entry.tags.join(", "))
      setEditSummary(entry.approvedSummary ?? "")
      setEditing(true)
    } catch {
      status.announce(
        "Unable to open this entry for editing. Check your connection and try again.",
        true
      )
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit(event: SubmitEvent) {
    event.preventDefault()
    const value = editText().trim()
    const tagValues = parseTags(editTags())
    if (value.length === 0) {
      status.announce("Write something before you save this entry.", true)
      return
    }
    if (tagValues.length > 25) {
      status.announce("Use 25 tags or fewer.", true)
      return
    }
    setBusy(true)
    try {
      const updated = await api(`/api/journal/${encodeURIComponent(props.entry.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          text: value,
          tags: tagValues,
          ...(editSummary().trim().length === 0 ? {} : { approvedSummary: editSummary().trim() })
        })
      })
      setFullEntry(parseJson(JournalEntry, updated))
      setEditing(false)
      status.announce("Journal changes saved privately.")
      await props.refresh()
    } catch {
      status.announce("Unable to save these changes. Check your connection and try again.", true)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm("Delete this journal entry and its search data? This cannot be undone."))
      return
    setBusy(true)
    try {
      await api(`/api/journal/${encodeURIComponent(props.entry.id)}`, { method: "DELETE" })
      status.announce("Journal entry deleted.")
      await props.refresh()
    } catch {
      status.announce("Unable to delete this entry. Check your connection and try again.", true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{formatDate(props.entry.createdAt)}</CardTitle>
        <CardDescription>
          {props.entry.tags.length === 0 ? "No tags" : props.entry.tags.join(" · ")}
        </CardDescription>
      </CardHeader>
      <Show when={props.entry.approvedSummary !== undefined}>
        <CardContent>
          <p>{props.entry.approvedSummary}</p>
        </CardContent>
      </Show>
      <Show when={fullEntry()}>
        {(entry) => <div class={styles.privateText}>{entry().text}</div>}
      </Show>
      <CardFooter class={styles.actionRow}>
        <Button variant="secondary" disabled={busy()} onClick={() => void openText()}>
          {fullEntry() === undefined ? "Open private text" : "Private text opened"}
        </Button>
        <Button variant="secondary" disabled={busy()} onClick={() => void startEditing()}>
          Edit entry
        </Button>
        <Button variant="danger" disabled={busy()} onClick={() => void remove()}>
          Delete entry
        </Button>
      </CardFooter>
      <Show when={editing()}>
        <form
          class={cn(styles.inlineForm, styles.editForm)}
          onSubmit={(event) => void saveEdit(event)}
        >
          <label class={styles.fieldLabel} for={`journal-edit-text-${props.entry.id}`}>
            Journal text
          </label>
          <Textarea
            id={`journal-edit-text-${props.entry.id}`}
            rows="8"
            maxlength="8000"
            required
            value={editText()}
            onInput={(event) => setEditText(event.currentTarget.value)}
          />
          <label class={styles.fieldLabel} for={`journal-edit-tags-${props.entry.id}`}>
            Tags
          </label>
          <Input
            id={`journal-edit-tags-${props.entry.id}`}
            maxlength="1200"
            value={editTags()}
            onInput={(event) => setEditTags(event.currentTarget.value)}
          />
          <label class={styles.fieldLabel} for={`journal-edit-summary-${props.entry.id}`}>
            Summary for your journal index (optional)
          </label>
          <Input
            id={`journal-edit-summary-${props.entry.id}`}
            maxlength="500"
            value={editSummary()}
            onInput={(event) => setEditSummary(event.currentTarget.value)}
          />
          <p class={styles.hint}>
            Journal text stays on this page. Bob sends neither the text nor the summary to the
            agent.
          </p>
          <div class={styles.actionRow}>
            <Button type="submit" disabled={busy()}>
              Save journal changes
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
              Cancel editing
            </Button>
          </div>
        </form>
      </Show>
    </Card>
  )
}

const alertLabels: Readonly<Record<OperationalAlert["code"], string>> = {
  inbound_exhausted: "A received message needs a safe retry.",
  delivery_uncertain: "A message delivery needs provider reconciliation.",
  delivery_result_exhausted: "A provider result reached its recovery queue.",
  agent_authentication_failed: "The Codex connection needs review.",
  reminder_missed: "A reminder passed its response deadline.",
  agent_quota_exhausted: "The Codex account reached its current usage limit.",
  agent_run_failed: "An assistant run stopped before it completed.",
  token_budget_exceeded: "Bob reached the saved token limit for this period."
}

function AlertsSection(props: ClientProps) {
  const status = useStatus()
  const [alerts, { refetch }] = createResource(
    () => (props.enabled() ? "ready" : undefined),
    async () => parseJson(AlertList, await api("/api/alerts")).alerts
  )
  const [refreshing, setRefreshing] = createSignal(false)

  async function refresh() {
    setRefreshing(true)
    try {
      await refetch()
    } catch {
      status.announce("Unable to load alerts. Check your connection and try again.", true)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section id="alerts" class={styles.contentSection} aria-labelledby="alerts-title">
      <SectionHeader
        eyebrow="Needs review"
        title="Alerts"
        id="alerts-title"
        action={
          <Button variant="secondary" disabled={refreshing()} onClick={() => void refresh()}>
            {refreshing() ? "Refreshing…" : "Refresh alerts"}
          </Button>
        }
      />
      <Notice tone="warning">
        <strong>Alerts contain identifiers and status only.</strong> They never contain message
        text.
      </Notice>
      <div class={styles.cardGrid} aria-busy={alerts.loading}>
        <Show when={!alerts.loading} fallback={<LoadingState />}>
          <Show
            when={(alerts() ?? []).filter((alert) => alert.state !== "resolved").length > 0}
            fallback={
              <EmptyState title="No open alerts" detail="Bob has no item that needs your review." />
            }
          >
            <For each={(alerts() ?? []).filter((alert) => alert.state !== "resolved")}>
              {(alert) => <AlertCard alert={alert} refresh={refetch} />}
            </For>
          </Show>
        </Show>
      </div>
    </section>
  )
}

function AlertCard(props: { alert: OperationalAlert; refresh: () => unknown }) {
  const status = useStatus()
  const [busy, setBusy] = createSignal(false)
  async function reconcile() {
    setBusy(true)
    try {
      await api(`/api/alerts/${encodeURIComponent(props.alert.id)}/reconcile`, {
        method: "POST",
        body: "{}"
      })
      status.announce("Alert review completed.")
      await props.refresh()
    } catch {
      status.announce("Unable to review this alert. Check the service and try again.", true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div class={styles.cardHeadingRow}>
          <CardTitle>{alertLabels[props.alert.code]}</CardTitle>
          <Badge variant={props.alert.state === "reconciling" ? "warning" : "danger"}>
            {props.alert.state}
          </Badge>
        </div>
        <CardDescription>{formatDate(props.alert.createdAt)}</CardDescription>
      </CardHeader>
      <Show when={props.alert.state !== "resolved"}>
        <CardFooter>
          <Button variant="secondary" disabled={busy()} onClick={() => void reconcile()}>
            {busy() ? "Reviewing…" : "Review safely"}
          </Button>
        </CardFooter>
      </Show>
    </Card>
  )
}
