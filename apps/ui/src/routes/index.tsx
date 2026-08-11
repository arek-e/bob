import { onMount } from "solid-js"
import { createFileRoute } from "@tanstack/solid-router"

import { ProtectedLayout } from "~/components/auth"
import { DashboardPage } from "~/components/dashboard"

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Dashboard · Bob" }] }),
  component: IndexRoute
})

function IndexRoute() {
  onMount(() => {
    document.title = "Dashboard · Bob"
  })

  return (
    <ProtectedLayout>
      <DashboardPage />
    </ProtectedLayout>
  )
}
