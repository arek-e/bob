import { createContext, createSignal, onMount, Show, useContext, type JSX } from "solid-js"

import { AppShell } from "~/components/app-shell"
import { loadOwnerSession, type OwnerSession } from "~/lib/auth-client"
import { styles } from "~/lib/styles"

const OwnerSessionContext = createContext<OwnerSession>()

export function useOwnerSession(): OwnerSession {
  const session = useContext(OwnerSessionContext)
  if (session === undefined) throw new Error("useOwnerSession must be used inside ProtectedLayout")
  return session
}

export function ProtectedLayout(props: { children: JSX.Element }) {
  const [session, setSession] = createSignal<OwnerSession | "loading">("loading")

  onMount(async () => {
    try {
      const value = await loadOwnerSession()
      if (value === null) {
        const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`
        window.location.assign(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`)
        return
      }
      setSession(value)
    } catch {
      window.location.assign("/sign-in")
    }
  })

  return (
    <Show
      when={session() !== "loading"}
      fallback={
        <div class={styles.routeLoading} role="status" aria-live="polite">
          Loading your private workspace…
        </div>
      }
    >
      <OwnerSessionContext.Provider value={session() as OwnerSession}>
        <AppShell session={session() as OwnerSession}>{props.children}</AppShell>
      </OwnerSessionContext.Provider>
    </Show>
  )
}
