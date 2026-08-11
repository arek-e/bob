import { splitProps, type JSX } from "solid-js"

import { styles } from "~/lib/styles"
import { cn } from "~/lib/utils"

export function Input(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const [local, rest] = splitProps(props, ["class"])
  return <input {...rest} class={cn(styles.input, local.class)} />
}
