import { splitProps, type JSX } from "solid-js"

import { cn } from "~/lib/utils"
import { styles } from "~/lib/styles"

export function Input(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const [local, rest] = splitProps(props, ["class"])
  return <input {...rest} class={cn(styles.input, local.class)} />
}
