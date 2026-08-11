import { onMount } from "solid-js"
import { createFileRoute } from "@tanstack/solid-router"

import { SignInPage } from "~/components/auth-pages"

export const Route = createFileRoute("/sign-in")({
  head: () => ({ meta: [{ title: "Sign in · Bob" }] }),
  component: SignInRoute
})

function SignInRoute() {
  onMount(() => {
    document.title = "Sign in · Bob"
  })

  return <SignInPage />
}
