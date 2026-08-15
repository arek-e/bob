import { createContext, createSignal, onMount, Show, useContext, type JSX } from "solid-js"

import { AppShell } from "~/components/app-shell"
import { loadOwnerSession, type OwnerSession } from "~/lib/api"
import { styles } from "~/lib/styles"

const OwnerSessionContext = createContext<OwnerSession>()

export function useOwnerSession(): OwnerSession {
  const session = useContext(OwnerSessionContext)
  if (session === undefined) throw new Error("useOwnerSession must be used inside ProtectedLayout")
  return session
}

export function ProtectedLayout(props: { children: JSX.Element }) {
  const [session, setSession] = createSignal<OwnerSession | "loading">("loading")
  const ownerSession = () => {
    const value = session()
    return value === "loading" ? undefined : value
  }

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
      when={ownerSession()}
      keyed
      fallback={
        <div class={styles.routeLoading} role="status" aria-live="polite">
          Loading your private workspace…
        </div>
      }
    >
      {(value) => (
        <OwnerSessionContext.Provider value={value}>
          <AppShell session={value}>{props.children}</AppShell>
        </OwnerSessionContext.Provider>
      )}
    </Show>
  )
}
