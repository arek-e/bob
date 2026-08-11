import { cva, type VariantProps } from "class-variance-authority"
import { splitProps, type JSX } from "solid-js"

import { cn } from "~/lib/utils"

const buttonVariants = cva("", {
  variants: {
    variant: {
      default: "bg-accent text-on-accent hover:bg-accent-strong",
      secondary: "border border-line-strong bg-surface text-ink hover:bg-surface-tint",
      danger:
        "border border-danger/30 bg-danger-soft text-danger hover:border-danger/50 hover:bg-danger-hover",
      ghost: "text-ink-soft hover:bg-surface-tint"
    },
    size: {
      default: "min-h-10 px-3 sm:min-h-9",
      sm: "min-h-9 px-2.5 text-xs sm:min-h-8",
      lg: "min-h-11 px-5 sm:min-h-10"
    }
  },
  defaultVariants: {
    variant: "default",
    size: "default"
  }
})

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>

export function Button(props: ButtonProps) {
  const [variants, rest] = splitProps(props, ["variant", "size", "class", "children"])
  return (
    <button
      {...rest}
      class={cn(
        "inline-flex items-center justify-center gap-2 rounded-control border border-transparent py-2 text-center text-sm leading-tight font-medium transition-[background-color,border-color,color,transform] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-wait disabled:opacity-60 motion-safe:active:scale-[0.96]",
        buttonVariants(variants),
        variants.class
      )}
    >
      {variants.children}
    </button>
  )
}
