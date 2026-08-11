import { Link } from "@tanstack/solid-router"
import LogOut from "lucide-solid/icons/log-out"
import Menu from "lucide-solid/icons/menu"
import Settings from "lucide-solid/icons/settings"
import X from "lucide-solid/icons/x"
import { createContext, createSignal, onCleanup, onMount, useContext, type JSX } from "solid-js"

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
  let menuDialog: HTMLDialogElement | undefined
  let menuTrigger: HTMLButtonElement | undefined

  const ownerInitial = () => props.session.user.name.trim().slice(0, 1).toUpperCase() || "B"
  const closeMenu = () => {
    if (menuDialog?.open) menuDialog.close()
  }
  const restoreMenuFocus = () => {
    if (menuTrigger?.getClientRects().length) menuTrigger.focus()
  }

  onMount(() => {
    const desktop = window.matchMedia("(min-width: 48rem)")
    const closeAtDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) closeMenu()
    }
    desktop.addEventListener("change", closeAtDesktop)
    onCleanup(() => desktop.removeEventListener("change", closeAtDesktop))
  })

  return (
    <StatusContext.Provider value={{ announce }}>
      <div class={styles.settingsFrame}>
        <a class={styles.skipLink} href="#main">
          Skip to content
        </a>

        <DesktopSidebar
          name={props.session.user.name}
          email={props.session.user.email}
          initial={ownerInitial()}
        />

        <dialog
          ref={(element) => (menuDialog = element)}
          class={styles.mobileDialog}
          aria-labelledby="mobile-navigation-title"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeMenu()
          }}
          onClose={restoreMenuFocus}
        >
          <div class={styles.mobileSheet}>
            <div class={styles.mobileSheetHeader}>
              <Brand mobile onNavigate={closeMenu} />
              <h2 id="mobile-navigation-title" class="sr-only">
                Navigation
              </h2>
              <button
                class={styles.iconButton}
                type="button"
                aria-label="Close menu"
                autofocus
                onClick={closeMenu}
              >
                <X size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            <PrimaryNavigation mobile onNavigate={closeMenu} />
            <div class={styles.mobileSheetSpacer} />
            <OwnerIdentity
              mobile
              name={props.session.user.name}
              email={props.session.user.email}
              initial={ownerInitial()}
            />
          </div>
        </dialog>

        <div class={styles.appPane}>
          <header class={styles.settingsHeader}>
            <button
              ref={(element) => (menuTrigger = element)}
              class={styles.mobileMenuButton}
              type="button"
              aria-label="Open menu"
              onClick={() => menuDialog?.showModal()}
            >
              <Menu size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <h1 class={styles.settingsHeaderTitle}>Settings</h1>
            <div class={styles.settingsHeaderActions}>
              <span class={styles.settingsOwner}>{props.session.user.email}</span>
              <span class={styles.topbarAvatar} aria-hidden="true">
                {ownerInitial()}
              </span>
              <button
                class={styles.topbarSignout}
                type="button"
                aria-label="Sign out"
                onClick={() => void signOut()}
              >
                <LogOut size={17} strokeWidth={1.75} aria-hidden="true" />
                <span class={styles.topbarSignoutLabel}>Sign out</span>
              </button>
            </div>
          </header>

          <main id="main" class={styles.settingsMain} tabindex="-1">
            <div
              class={status().error ? styles.statusRegionError : styles.statusRegion}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {status().message}
            </div>
            {props.children}
          </main>
        </div>
      </div>
    </StatusContext.Provider>
  )
}

function DesktopSidebar(props: { name: string; email: string; initial: string }) {
  return (
    <aside class={styles.desktopSidebar}>
      <div class={styles.desktopSidebarInner}>
        <Brand />
        <PrimaryNavigation />
        <div class={styles.sidebarSpacer} />
        <OwnerIdentity name={props.name} email={props.email} initial={props.initial} />
      </div>
    </aside>
  )
}

function Brand(props: { mobile?: boolean; onNavigate?: () => void }) {
  return (
    <Link
      class={props.mobile ? styles.mobileBrand : styles.sidebarBrand}
      to="/settings"
      aria-label="Bob settings"
      preload={false}
      onClick={props.onNavigate}
    >
      <span class={styles.sidebarBrandMark} aria-hidden="true">
        <span class={styles.sidebarBrandDot} />
        <span class={styles.sidebarBrandDot} />
        <span class={styles.sidebarBrandDot} />
        <span class={styles.sidebarBrandDot} />
      </span>
      <span class={styles.sidebarBrandName}>Bob</span>
    </Link>
  )
}

function PrimaryNavigation(props: { mobile?: boolean; onNavigate?: () => void }) {
  return (
    <nav
      class={props.mobile ? styles.mobileNavigation : styles.sidebarNavigation}
      aria-label="Primary navigation"
    >
      <Link
        class={props.mobile ? styles.mobileNavLinkActive : styles.sidebarNavLinkActive}
        to="/settings"
        aria-current="page"
        preload={false}
        onClick={props.onNavigate}
      >
        <Settings size={20} strokeWidth={1.75} aria-hidden="true" />
        <span class={props.mobile ? styles.mobileNavLabel : styles.sidebarNavLabel}>Settings</span>
      </Link>
    </nav>
  )
}

function OwnerIdentity(props: { name: string; email: string; initial: string; mobile?: boolean }) {
  return (
    <div class={props.mobile ? styles.mobileOwner : styles.sidebarOwner}>
      <span class={styles.sidebarAvatar} aria-hidden="true">
        {props.initial}
      </span>
      <span class={props.mobile ? styles.mobileOwnerCopy : styles.sidebarOwnerCopy}>
        <span class={styles.sidebarOwnerName}>{props.name}</span>
        <span class={styles.sidebarOwnerEmail}>{props.email}</span>
      </span>
    </div>
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
