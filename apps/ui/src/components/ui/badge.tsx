import { cva, type VariantProps } from "class-variance-authority"
import { splitProps, type JSX } from "solid-js"

import { cn } from "~/lib/utils"

const badgeVariants = cva(
  "inline-flex min-h-7 items-center rounded-full px-2 py-1 text-[0.68rem] font-extrabold leading-tight",
  {
    variants: {
      variant: {
        neutral: "bg-surface-tint text-ink-soft",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-danger",
        info: "bg-info-soft text-info"
      }
    },
    defaultVariants: { variant: "neutral" }
  }
)

export type BadgeProps = JSX.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>

export function Badge(props: BadgeProps) {
  const [variants, rest] = splitProps(props, ["variant", "class", "children"])
  return (
    <span {...rest} class={cn(badgeVariants(variants), variants.class)}>
      {variants.children}
    </span>
  )
}
