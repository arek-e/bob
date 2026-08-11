import { Link } from "@tanstack/solid-router"
import LogOut from "lucide-solid/icons/log-out"
import Settings from "lucide-solid/icons/settings"
import { createContext, createSignal, useContext, type JSX } from "solid-js"

import type { OwnerSession } from "~/lib/api"

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
  const [status, setStatus] = createSignal<StatusState>({ message: "", error: false })
  const announce = (message: string, error = false) => setStatus({ message, error })

  return (
    <StatusContext.Provider value={{ announce }}>
      <div class={styles.settingsFrame}>
        <a class={styles.skipLink} href="#main">
          Skip to content
        </a>

        <header class={styles.settingsHeader}>
          <div class={styles.settingsHeaderInner}>
            <Link class={styles.brand} to="/settings" aria-label="Bob settings">
              <span class={styles.brandMark} aria-hidden="true">
                B
              </span>
              <span class={styles.brandName}>Bob</span>
            </Link>
            <div class={styles.settingsHeaderTitle}>
              <Settings size={16} strokeWidth={2} aria-hidden="true" />
              <span>Settings</span>
            </div>
            <div class={styles.settingsHeaderActions}>
              <span class={styles.settingsOwner}>{props.session.user.email}</span>
              <span class={styles.topbarAvatar} aria-hidden="true">
                {props.session.user.name.slice(0, 1).toUpperCase()}
              </span>
              <button class={styles.topbarSignout} type="button" onClick={signOut}>
                <LogOut size={16} strokeWidth={2} aria-hidden="true" />
                Sign out
              </button>
            </div>
          </div>
        </header>

        <main id="main" class={styles.settingsMain} tabindex="-1">
          <div
            class={status().error ? styles.statusRegionError : styles.statusRegion}
            role="status"
            aria-live="polite"
          >
            {status().message}
          </div>
          {props.children}
        </main>
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
