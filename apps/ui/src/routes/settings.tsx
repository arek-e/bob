import { onMount } from "solid-js"
import { createFileRoute } from "@tanstack/solid-router"

import { ProtectedLayout } from "~/components/auth"
import { SettingsPage } from "~/components/settings"

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings · Bob" }] }),
  component: SettingsRoute
})

function SettingsRoute() {
  onMount(() => {
    document.title = "Settings · Bob"
  })

  return (
    <ProtectedLayout>
      <SettingsPage />
    </ProtectedLayout>
  )
}
