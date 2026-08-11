import { splitProps, type JSX } from "solid-js"

import { cn } from "~/lib/utils"
import { styles } from "~/lib/styles"

export function Select(props: JSX.SelectHTMLAttributes<HTMLSelectElement>) {
  const [local, rest] = splitProps(props, ["class"])
  return <select {...rest} class={cn(styles.input, styles.select, local.class)} />
}
