import type { JSX } from "solid-js"

import { styles } from "~/lib/styles"
import { cn } from "~/lib/utils"

export function Notice(props: { children: JSX.Element; tone?: "info" | "warning" }) {
  return (
    <aside class={cn(styles.notice, props.tone === "warning" && styles.noticeWarning)}>
      {props.children}
    </aside>
  )
}
