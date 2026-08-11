import type { JSX } from "solid-js"

import { cn } from "~/lib/utils"
import { styles } from "~/lib/styles"

export function Notice(props: { children: JSX.Element; tone?: "info" | "warning" }) {
  return (
    <aside class={cn(styles.notice, props.tone === "warning" && styles.noticeWarning)}>
      {props.children}
    </aside>
  )
}
