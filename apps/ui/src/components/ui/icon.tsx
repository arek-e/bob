import { splitProps, type JSX } from "solid-js"

import { cn } from "~/lib/utils"

export type IconName =
  | "arrow-up-right"
  | "calendar"
  | "chevron-down"
  | "dashboard"
  | "file"
  | "journal"
  | "log-out"
  | "plus"
  | "search"
  | "settings"
  | "sparkle"

export function Icon(
  props: {
    name: IconName
    size?: number
    strokeWidth?: number
    class?: string
  } & JSX.SvgSVGAttributes<SVGSVGElement>
) {
  const [local, rest] = splitProps(props, ["name", "size", "strokeWidth", "class"])

  return (
    <svg
      {...rest}
      class={cn("block shrink-0", local.class)}
      width={local.size ?? 16}
      height={local.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={local.strokeWidth ?? 1.7}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {iconPaths[local.name]()}
    </svg>
  )
}

const iconPaths: Record<IconName, () => JSX.Element> = {
  "arrow-up-right": () => (
    <>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </>
  ),
  calendar: () => (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17" />
    </>
  ),
  "chevron-down": () => <path d="m7 9.5 5 5 5-5" />,
  dashboard: () => (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  file: () => (
    <>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4M9 12h6M9 15.5h6" />
    </>
  ),
  journal: () => (
    <>
      <path d="M5 4.5h13.5A1.5 1.5 0 0 1 20 6v13.5H6.5A1.5 1.5 0 0 1 5 18z" />
      <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4H8v15.5M11 9h6M11 12.5h6M11 16h4" />
    </>
  ),
  "log-out": () => (
    <>
      <path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14" />
      <path d="m16 8 4 4-4 4M20 12H9" />
    </>
  ),
  plus: () => (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  search: () => (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  settings: () => (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-2.5v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H6.5v-2.5h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2h2.5v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2V14h-.2a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  sparkle: () => (
    <>
      <path d="m12 3 1.1 4.2a4.9 4.9 0 0 0 3.7 3.7L21 12l-4.2 1.1a4.9 4.9 0 0 0-3.7 3.7L12 21l-1.1-4.2a4.9 4.9 0 0 0-3.7-3.7L3 12l4.2-1.1a4.9 4.9 0 0 0 3.7-3.7z" />
    </>
  )
}
