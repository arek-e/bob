import { createContext, createSignal, Show, useContext, type JSX } from "solid-js"
import { Link, useLocation } from "@tanstack/solid-router"

import { Icon } from "~/components/ui/icon"
import type { OwnerSession } from "~/lib/api"
import { cn } from "~/lib/utils"
import { styles } from "~/lib/styles"

interface StatusState {
  readonly message: string
  readonly error: boolean
}

interface StatusContextValue {
  readonly announce: (message: string, error?: boolean) => void
}

const StatusContext = createContext<StatusContextValue>()

export function useStatus(): StatusContextValue {
  const context = useContext(StatusContext)
  if (context === undefined) throw new Error("useStatus must be used inside AppShell")
  return context
}

export function AppShell(props: { session: OwnerSession; children: JSX.Element }) {
  const location = useLocation()
  const [status, setStatus] = createSignal<StatusState>({ message: "", error: false })
  const announce = (message: string, error = false) => setStatus({ message, error })

  return (
    <StatusContext.Provider value={{ announce }}>
      <div class={styles.appFrame}>
        <a class={styles.skipLink} href="#main">
          Skip to content
        </a>

        <aside class={styles.sidebar} aria-label="Workspace navigation">
          <div class={styles.sidebarHeader}>
            <Link
              class={styles.brand}
              to="/"
              aria-label="Bob dashboard"
              activeOptions={{ exact: true }}
            >
              <span class={styles.brandMark} aria-hidden="true">
                B
              </span>
              <span class={styles.brandName}>Bob</span>
            </Link>
            <div class={styles.workspaceSwitch}>
              <span class={styles.workspaceSwitchDot} aria-hidden="true" />
              <span>My Space</span>
              <Icon name="chevron-down" size={13} />
            </div>
          </div>

          <div class={styles.sidebarLabel}>Workspace</div>
          <nav class={styles.sidebarNav} aria-label="Main navigation">
            <Link
              to="/"
              class={cn(styles.navLink, location().pathname === "/" && styles.navLinkActive)}
              activeOptions={{ exact: true }}
            >
              <Icon
                name="dashboard"
                class={cn(styles.navIcon, location().pathname === "/" && styles.navIconActive)}
              />
              <span>Overview</span>
            </Link>
            <a class={styles.navLink} href="/#journal">
              <Icon name="journal" class={styles.navIcon} />
              <span>Journal</span>
            </a>
            <Link
              to="/settings"
              class={cn(
                styles.navLink,
                location().pathname === "/settings" && styles.navLinkActive
              )}
            >
              <Icon
                name="settings"
                class={cn(
                  styles.navIcon,
                  location().pathname === "/settings" && styles.navIconActive
                )}
              />
              <span>Settings</span>
            </Link>
          </nav>

          <div class={cn(styles.sidebarLabel, styles.sidebarLabelSecondary)}>Collections</div>
          <nav class={styles.sidebarNav} aria-label="Dashboard collections">
            <a class={cn(styles.navLink, styles.navLinkMuted)} href="/#memory">
              <Icon name="file" class={styles.navIcon} />
              <span>Memory</span>
            </a>
            <a class={cn(styles.navLink, styles.navLinkMuted)} href="/#training">
              <Icon name="sparkle" class={styles.navIcon} />
              <span>Training</span>
            </a>
            <a class={cn(styles.navLink, styles.navLinkMuted)} href="/#alerts">
              <Icon name="calendar" class={styles.navIcon} />
              <span>Alerts</span>
            </a>
          </nav>

          <div class={styles.sidebarSpacer} />
          <a class={styles.sidebarAdd} href="/#journal">
            <span class={styles.sidebarAddIcon} aria-hidden="true">
              <Icon name="plus" size={14} />
            </span>
            <span>New journal entry</span>
          </a>
          <div class={styles.sidebarAccount}>
            <span class={styles.avatar} aria-hidden="true">
              {props.session.user.name.slice(0, 1).toUpperCase()}
            </span>
            <span class={styles.accountCopy}>
              <strong class={styles.accountName}>{props.session.user.name}</strong>
              <span class={styles.accountEmail}>{props.session.user.email}</span>
            </span>
          </div>
        </aside>

        <div class={styles.appContent}>
          <header class={styles.topbar}>
            <div class={styles.topbarInner}>
              <div class={styles.topbarPage}>
                <span class={styles.topbarPageIcon} aria-hidden="true">
                  <Icon
                    name={location().pathname === "/settings" ? "settings" : "dashboard"}
                    size={14}
                  />
                </span>
                <span class={styles.topbarPageTitle}>
                  {location().pathname === "/settings" ? "Settings" : "Overview"}
                </span>
                <span class={styles.topbarPageMuted}>Private workspace</span>
              </div>
              <div class={styles.topbarActions}>
                <span class={styles.topbarDate}>Owner workspace</span>
                <span class={styles.topbarDivider} aria-hidden="true" />
                <span class={styles.topbarAvatar} aria-hidden="true">
                  {props.session.user.name.slice(0, 1).toUpperCase()}
                </span>
                <button class={styles.topbarSignout} type="button" onClick={signOut}>
                  <Icon name="log-out" size={14} />
                  Sign out
                </button>
              </div>
            </div>
          </header>

          <div class={cn(styles.workspaceBody, styles.workspaceBodyWithInspector)}>
            <main id="main" class={styles.mainContent} tabindex="-1">
              <div
                class={cn(styles.statusRegion, status().error && styles.statusRegionError)}
                role="status"
                aria-live="polite"
              >
                {status().message}
              </div>
              {props.children}
            </main>

            <aside class={styles.inspector} aria-label="Workspace tools">
              <div class={styles.inspectorTabs} aria-hidden="true">
                <span class={cn(styles.inspectorTab, styles.inspectorTabActive)}>Overview</span>
                <span class={styles.inspectorTab}>Info</span>
              </div>
              <Show
                when={location().pathname === "/"}
                fallback={
                  <>
                    <p class={styles.inspectorKicker}>Settings</p>
                    <p class={styles.inspectorTitle}>Workspace controls</p>
                    <a class={styles.inspectorRow} href="#locality">
                      <Icon name="settings" size={15} />
                      <span>Locality</span>
                      <Icon name="arrow-up-right" class={styles.inspectorRowArrow} size={13} />
                    </a>
                    <a class={styles.inspectorRow} href="#connections">
                      <Icon name="file" size={15} />
                      <span>Connections</span>
                      <Icon name="arrow-up-right" class={styles.inspectorRowArrow} size={13} />
                    </a>
                  </>
                }
              >
                <p class={styles.inspectorKicker}>Quick add</p>
                <p class={styles.inspectorTitle}>Keep the page moving</p>
                <a class={styles.inspectorRow} href="#journal">
                  <Icon name="journal" size={15} />
                  <span>Journal entry</span>
                  <Icon name="plus" class={styles.inspectorRowArrow} size={13} />
                </a>
                <a class={styles.inspectorRow} href="#reminders">
                  <Icon name="calendar" size={15} />
                  <span>Reminder review</span>
                  <Icon name="arrow-up-right" class={styles.inspectorRowArrow} size={13} />
                </a>
                <a class={styles.inspectorRow} href="#training">
                  <Icon name="sparkle" size={15} />
                  <span>Training changes</span>
                  <Icon name="arrow-up-right" class={styles.inspectorRowArrow} size={13} />
                </a>
              </Show>
              <div class={styles.inspectorDivider} />
              <div class={styles.inspectorNote}>
                <span class={styles.inspectorNoteDot} aria-hidden="true" />
                <span>Private by default</span>
              </div>
              <p class={styles.inspectorCopy}>Review each change before Bob saves or sends it.</p>
            </aside>
          </div>
        </div>
      </div>
    </StatusContext.Provider>
  )
}

async function signOut(): Promise<void> {
  try {
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    })
  } finally {
    window.location.assign("/sign-in")
  }
}
