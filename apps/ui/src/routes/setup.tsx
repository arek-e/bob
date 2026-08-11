import { createFileRoute } from "@tanstack/solid-router"
import { onMount } from "solid-js"

import { SetupPage } from "~/components/auth-pages"

export const Route = createFileRoute("/setup")({
  head: () => ({ meta: [{ title: "Set up owner login · Bob" }] }),
  component: SetupRoute
})

function SetupRoute() {
  onMount(() => {
    document.title = "Set up owner login · Bob"
  })

  return <SetupPage />
}
