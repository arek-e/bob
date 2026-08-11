export const styles = {
  routeLoading: "grid min-h-svh place-items-center p-8 text-sm text-ink-soft",
  skipLink:
    "fixed left-3 top-3 z-50 -translate-y-[160%] rounded-control bg-surface px-3 py-2 text-sm font-semibold text-ink no-underline outline-none transition-transform duration-150 focus:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  settingsFrame: "min-h-svh min-w-80 bg-canvas font-sans text-ink antialiased",
  settingsHeader:
    "sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85",
  settingsHeaderInner:
    "mx-auto flex min-h-[4.25rem] w-full max-w-[72rem] items-center gap-4 px-4 sm:px-6 lg:px-8",
  brand:
    "inline-flex items-center gap-2.5 rounded-control py-1 text-ink no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  brandMark:
    "grid size-7 place-items-center rounded-control bg-accent text-xs font-extrabold text-white",
  brandName: "text-sm font-extrabold tracking-tight",
  settingsHeaderTitle:
    "flex items-center gap-2 border-l border-line pl-4 text-sm font-bold text-ink-soft",
  settingsHeaderActions: "ml-auto flex min-w-0 items-center gap-3",
  settingsOwner: "max-w-64 truncate text-xs text-ink-soft max-[42rem]:hidden",
  topbarAvatar:
    "grid size-8 shrink-0 place-items-center rounded-full bg-avatar text-[0.68rem] font-extrabold text-avatar-ink max-[30rem]:hidden",
  topbarSignout:
    "inline-flex min-h-10 items-center gap-1.5 rounded-control border border-transparent px-2.5 text-xs font-bold text-ink-soft transition-[color,background-color,border-color] duration-150 hover:border-line hover:bg-surface-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  settingsMain:
    "mx-auto min-h-[calc(100svh-4.25rem)] w-full max-w-[72rem] px-4 pb-20 sm:px-6 lg:px-8",
  statusRegion: "mb-1 min-h-5 text-xs font-bold text-accent",
  statusRegionError: "mb-1 min-h-5 text-xs font-bold text-danger",
  pageIntro: "py-10 pb-7 sm:py-12 sm:pb-8",
  introCopy: "max-w-[39rem]",
  eyebrow: "mb-2 text-[0.7rem] font-extrabold uppercase tracking-[0.13em] text-accent",
  heading1:
    "m-0 mb-2 text-[clamp(2rem,4vw,3rem)] font-semibold leading-none tracking-[-0.035em] text-ink",
  heading2:
    "m-0 text-[clamp(1.45rem,2.4vw,1.9rem)] font-semibold leading-tight tracking-[-0.035em] text-ink",
  introText: "m-0 max-w-[36rem] text-sm text-ink-soft",
  settingsStack: "grid gap-14",
  contentSection: "scroll-mt-24",
  sectionHeading:
    "mb-4 flex items-end justify-between gap-4 max-[38rem]:flex-col max-[38rem]:items-start",
  sectionIntro: "mb-4 max-w-[48rem] text-sm text-ink-soft",
  actionRow: "flex items-center gap-3 max-[38rem]:flex-wrap",
  cardHeadingRow: "flex items-start justify-between gap-3",
  hint: "m-0 text-xs leading-relaxed text-ink-soft",
  uiCard: "min-w-0 rounded-panel border border-line bg-surface p-5",
  uiCardHeader: "grid gap-1",
  uiCardTitle: "m-0 text-base font-semibold leading-tight tracking-[-0.025em] text-ink",
  uiCardDescription: "m-0 text-xs leading-relaxed text-ink-soft",
  uiCardContent: "mt-3 grid gap-3 text-sm text-ink-soft",
  formCard: "grid gap-5 rounded-panel border border-line bg-surface p-5",
  formIntro: "m-0 text-sm text-ink-soft",
  fieldGroup: "grid gap-2",
  fieldLabel: "text-xs font-extrabold text-ink",
  fieldError: "m-0 text-xs font-bold text-danger",
  loginCode:
    "mt-1 grid gap-2 rounded-control border border-line bg-surface-soft p-3 text-sm text-ink-soft",
  loginCodeOutput: "text-2xl font-extrabold tracking-[0.12em] text-ink",
  settingsGrid: "grid items-start gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(15rem,0.75fr)]",
  connectionGrid: "grid grid-cols-1 items-start gap-4 md:grid-cols-2",
  connectionCard: "grid gap-1",
  messageExamples: "grid gap-3 text-sm text-ink-soft [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
  authLayout: "min-h-svh bg-surface text-ink",
  authHeader: "mx-auto w-full max-w-[72rem] px-6 py-7 sm:px-10",
  authLogo:
    "inline-flex items-center gap-3 rounded-control text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent",
  authLogoMark: "grid size-8 grid-cols-2 place-items-center gap-1 p-1",
  authLogoDot: "size-2 rounded-full bg-ink",
  authLogoName: "text-sm font-semibold tracking-tight",
  authHero:
    "mx-auto grid min-h-[calc(100svh-6rem)] w-full max-w-[42rem] place-items-center px-6 pb-16 pt-6 sm:px-10 sm:pb-24",
  authCard: "w-full max-w-[31.75rem] p-6 sm:p-8",
  authKicker: "mb-5 text-xs font-semibold uppercase tracking-[0.12em] text-ink-soft",
  authTitle:
    "m-0 max-w-[31rem] text-[clamp(2.5rem,7vw,4rem)] font-semibold leading-[0.98] tracking-[-0.055em] text-ink",
  authTitleMuted: "block text-ink-faint",
  authStatus: "mt-4 min-h-5 text-xs text-danger",
  authForm: "grid gap-4",
  authHelp: "m-0 mt-6 max-w-[31.75rem] text-xs leading-relaxed text-ink-soft",
  authTerms: "m-0 mt-5 max-w-[31.75rem] text-xs leading-relaxed text-ink-faint",
  authFooter: "mt-6 text-xs text-ink-soft",
  notice:
    "rounded-control border border-line border-l-4 border-l-accent bg-surface-soft p-4 text-sm text-ink-soft",
  noticeWarning: "border-warning/30 border-l-warning bg-warning-soft",
  noticeHeading: "m-0 mb-2 text-sm font-semibold text-ink",
  noticeParagraph: "m-0 text-sm leading-relaxed text-ink-soft",
  input:
    "block min-h-10 w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none transition-[border-color] duration-150 placeholder:text-ink-faint hover:border-ink-soft focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  select: "appearance-auto"
} as const
