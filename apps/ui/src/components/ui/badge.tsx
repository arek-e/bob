import { cva, type VariantProps } from "class-variance-authority"
import { splitProps, type JSX } from "solid-js"

import { cn } from "~/lib/utils"

const badgeVariants = cva(
  "inline-flex min-h-6 shrink-0 items-center rounded-control border px-2 py-1 text-xs leading-tight font-medium",
  {
    variants: {
      variant: {
        neutral: "border-line bg-surface-tint text-ink-soft",
        success: "border-success/20 bg-success-soft text-success",
        warning: "border-warning/20 bg-warning-soft text-warning",
        danger: "border-danger/20 bg-danger-soft text-danger",
        info: "border-info/20 bg-info-soft text-info"
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
