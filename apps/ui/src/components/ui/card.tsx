import { splitProps, type JSX } from "solid-js"

import { styles } from "~/lib/styles"
import { cn } from "~/lib/utils"

type CardProps = JSX.HTMLAttributes<HTMLElement>
type SurfaceProps = JSX.HTMLAttributes<HTMLDivElement>

export function Card(props: CardProps) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <article {...rest} class={cn(styles.uiCard, local.class)}>
      {local.children}
    </article>
  )
}

export function CardHeader(props: SurfaceProps) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <div {...rest} class={cn(styles.uiCardHeader, local.class)}>
      {local.children}
    </div>
  )
}

export function CardTitle(props: JSX.HTMLAttributes<HTMLHeadingElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <h3 {...rest} class={cn(styles.uiCardTitle, local.class)}>
      {local.children}
    </h3>
  )
}

export function CardDescription(props: JSX.HTMLAttributes<HTMLParagraphElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <p {...rest} class={cn(styles.uiCardDescription, local.class)}>
      {local.children}
    </p>
  )
}

export function CardContent(props: SurfaceProps) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <div {...rest} class={cn(styles.uiCardContent, local.class)}>
      {local.children}
    </div>
  )
}

export function CardFooter(props: SurfaceProps) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <div {...rest} class={cn(styles.uiCardFooter, local.class)}>
      {local.children}
    </div>
  )
}
