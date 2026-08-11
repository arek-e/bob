import { splitProps, type JSX } from "solid-js"

import { cn } from "~/lib/utils"

export function Label(props: JSX.LabelHTMLAttributes<HTMLLabelElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <label
      {...rest}
      class={cn(
        "text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        local.class
      )}
    >
      {local.children}
    </label>
  )
}
