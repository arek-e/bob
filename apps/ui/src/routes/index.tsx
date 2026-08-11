import { createFileRoute } from "@tanstack/solid-router"
import { onMount } from "solid-js"

import { ProtectedLayout } from "~/components/auth"
import { SettingsPage } from "~/components/settings"

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Settings · Bob" }] }),
  component: IndexRoute
})

function IndexRoute() {
  onMount(() => {
    document.title = "Settings · Bob"
  })

  return (
    <ProtectedLayout>
      <SettingsPage />
    </ProtectedLayout>
  )
}
