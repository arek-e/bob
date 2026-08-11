import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/solid-router"
import * as Solid from "solid-js"
import { HydrationScript } from "solid-js/web"

import { styles } from "~/lib/styles"
import appCss from "~/styles/app.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "description", content: "Private owner settings for Bob." },
      { title: "Bob" }
    ],
    links: [{ rel: "stylesheet", href: appCss }]
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <div class={styles.routeLoading}>
      <h1 class={styles.heading1}>Page not found</h1>
      <a href="/settings">Return to settings</a>
    </div>
  ),
  shellComponent: RootDocument
})

function RootComponent() {
  return (
    <Solid.Suspense>
      <Outlet />
    </Solid.Suspense>
  )
}

function RootDocument(props: { children: Solid.JSX.Element }) {
  return (
    <html class="min-w-80 scroll-smooth bg-canvas font-sans text-ink antialiased" lang="en">
      <head>
        <HydrationScript />
        <HeadContent />
      </head>
      <body class="min-h-svh min-w-80 bg-canvas">
        {props.children}
        <Scripts />
      </body>
    </html>
  )
}
