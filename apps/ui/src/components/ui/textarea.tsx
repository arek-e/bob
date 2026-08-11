import { splitProps, type JSX } from "solid-js"

import { cn } from "~/lib/utils"
import { styles } from "~/lib/styles"

export function Textarea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const [local, rest] = splitProps(props, ["class"])
  return <textarea {...rest} class={cn(styles.input, styles.textarea, local.class)} />
}
