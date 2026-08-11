export const styles = {
  routeLoading: "grid min-h-svh place-items-center bg-canvas p-8 text-sm text-ink-soft",
  skipLink:
    "fixed start-3 top-3 z-[70] -translate-y-[160%] border border-line bg-surface px-3 py-2 text-sm font-medium text-ink no-underline outline-none transition-transform duration-150 focus:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",

  settingsFrame: "min-h-svh min-w-80 bg-canvas font-sans text-ink antialiased",
  desktopSidebar:
    "group fixed inset-y-0 start-0 z-30 hidden w-[4.375rem] overflow-hidden border-e border-line bg-surface transition-[width] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] hover:w-60 focus-within:w-60 md:block motion-reduce:transition-none",
  desktopSidebarInner: "flex min-h-svh w-60 flex-col bg-surface",
  sidebarBrand:
    "flex h-[4.375rem] w-full shrink-0 items-center border-b border-line text-ink no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
  sidebarBrandMark:
    "ms-[1.1875rem] grid size-8 shrink-0 grid-cols-2 place-items-center gap-1 p-1.5",
  sidebarBrandDot: "size-1.5 rounded-full bg-ink",
  sidebarBrandName:
    "ms-3 whitespace-nowrap text-sm font-semibold tracking-[-0.01em] opacity-100 transition-opacity duration-150 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 motion-reduce:transition-none",
  sidebarNavigation: "grid gap-2 px-[0.9375rem] py-4",
  sidebarNavLinkActive:
    "flex h-10 w-[13.125rem] items-center gap-4 border border-nav-border bg-nav-active px-[0.5625rem] text-ink no-underline transition-[background-color,border-color,color] duration-150 hover:bg-surface-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
  sidebarNavLabel:
    "whitespace-nowrap text-sm font-medium opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none",
  sidebarSpacer: "flex-1",
  sidebarOwner: "flex min-h-16 w-60 items-center border-t border-line py-3 text-ink",
  sidebarAvatar:
    "ms-[1.1875rem] grid size-8 shrink-0 place-items-center border border-line-strong bg-avatar text-xs font-semibold text-avatar-ink",
  sidebarOwnerCopy:
    "ms-3 grid min-w-0 max-w-[10rem] gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none",
  sidebarOwnerName: "truncate text-sm font-medium text-ink",
  sidebarOwnerEmail: "truncate text-xs text-ink-soft",

  mobileDialog:
    "fixed inset-0 m-0 h-svh max-h-none w-[min(75vw,24rem)] max-w-none overflow-visible border-0 bg-transparent p-0 text-ink outline-none backdrop:bg-black/40 md:hidden",
  mobileSheet: "flex h-full w-full flex-col border-e border-line bg-surface",
  mobileSheetHeader: "flex h-[4.375rem] shrink-0 items-center border-b border-line pe-4",
  mobileBrand:
    "flex h-[4.375rem] min-w-0 flex-1 items-center text-ink no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
  mobileNavigation: "grid gap-2 px-4 py-4",
  mobileNavLinkActive:
    "flex min-h-10 items-center gap-3 border border-nav-border bg-nav-active px-3 text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
  mobileNavLabel: "text-sm font-medium",
  mobileSheetSpacer: "flex-1",
  mobileOwner: "flex min-h-20 items-center border-t border-line pe-5",
  mobileOwnerCopy: "ms-3 grid min-w-0 gap-0.5",
  iconButton:
    "grid size-10 shrink-0 place-items-center border border-transparent text-ink-soft transition-[background-color,border-color,color,transform] duration-150 hover:border-line hover:bg-surface-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-safe:active:scale-[0.96]",

  appPane: "min-h-svh md:ps-[4.375rem]",
  settingsHeader:
    "sticky top-0 z-20 flex h-[4.375rem] items-center border-b border-line bg-surface/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/85 md:px-6",
  mobileMenuButton:
    "me-3 grid size-10 place-items-center border border-line bg-surface text-ink transition-[background-color,border-color,transform] duration-150 hover:bg-surface-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus md:hidden motion-safe:active:scale-[0.96]",
  settingsHeaderTitle: "m-0 text-sm font-medium tracking-[-0.01em] text-ink",
  settingsHeaderActions: "ms-auto flex min-w-0 items-center gap-2",
  settingsOwner: "max-w-64 truncate text-xs text-ink-soft max-[42rem]:hidden",
  topbarAvatar:
    "grid size-8 shrink-0 place-items-center border border-line-strong bg-avatar text-xs font-semibold text-avatar-ink max-[27rem]:hidden",
  topbarSignout:
    "inline-flex min-h-10 items-center justify-center gap-2 border border-transparent px-2.5 text-xs font-medium text-ink-soft transition-[background-color,border-color,color,transform] duration-150 hover:border-line hover:bg-surface-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-safe:active:scale-[0.96]",
  topbarSignoutLabel: "max-[34rem]:sr-only",
  settingsMain: "min-h-[calc(100svh-4.375rem)] bg-canvas outline-none",
  statusRegion:
    "pointer-events-none fixed end-4 top-[5.25rem] z-40 max-w-[min(24rem,calc(100vw-2rem))] border border-line bg-surface px-4 py-3 text-sm font-medium text-ink empty:invisible",
  statusRegionError:
    "pointer-events-none fixed end-4 top-[5.25rem] z-40 max-w-[min(24rem,calc(100vw-2rem))] border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-medium text-danger empty:invisible",

  settingsNav:
    "sticky top-[4.375rem] z-10 flex min-h-16 items-center overflow-x-auto bg-canvas px-4 md:px-8",
  settingsNavList: "flex min-w-max list-none items-center gap-6 p-0",
  settingsNavLink:
    "relative inline-flex min-h-10 items-center text-sm font-normal text-ink-soft no-underline transition-colors duration-150 after:absolute after:inset-x-0 after:bottom-0 after:h-px after:origin-start after:scale-x-0 after:bg-ink after:transition-transform after:duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
  settingsNavLinkActive: "font-medium text-ink after:scale-x-100",
  settingsContent: "w-full max-w-[50rem] px-4 pb-16 pt-8 md:px-8 md:pb-24",
  settingsStack: "grid gap-12",
  contentSection: "grid scroll-mt-[9rem] gap-6",
  sectionHeading:
    "flex items-start justify-between gap-4 max-[38rem]:flex-col max-[38rem]:items-stretch",
  sectionHeadingCopy: "grid max-w-[36rem] gap-1.5",
  sectionTitle: "m-0 text-lg font-medium leading-tight tracking-[-0.015em] text-ink",
  sectionIntro: "m-0 text-sm leading-relaxed text-ink-soft",
  actionRow: "flex flex-wrap items-center gap-2",
  cardHeadingRow: "flex items-start justify-between gap-3",

  uiCard: "min-w-0 border border-line bg-surface",
  uiCardHeader: "grid gap-1.5 p-5 pb-0 sm:p-6 sm:pb-0",
  uiCardTitle: "m-0 text-lg font-medium leading-tight tracking-[-0.015em] text-ink",
  uiCardDescription: "m-0 text-sm leading-relaxed text-ink-soft",
  uiCardContent: "grid gap-4 p-5 sm:p-6",
  uiCardFooter:
    "flex items-center justify-between gap-5 border-t border-line p-5 sm:p-6 max-[38rem]:flex-col max-[38rem]:items-stretch",
  formCard: "border border-line bg-surface",
  formCardHeader: "grid gap-1.5 p-5 pb-0 sm:p-6 sm:pb-0",
  formCardContent: "grid gap-5 p-5 sm:p-6",
  formCardFooter:
    "flex items-center justify-between gap-5 border-t border-line p-5 sm:p-6 max-[38rem]:flex-col max-[38rem]:items-stretch",
  formIntro: "m-0 text-sm leading-relaxed text-ink-soft",
  formFields: "grid gap-5",
  fieldGroup: "grid max-w-[18.75rem] gap-2",
  fieldLabel: "text-sm font-medium text-ink",
  fieldError: "m-0 text-xs font-medium text-danger",
  footerCopy: "grid max-w-[33rem] gap-1",
  footerTitle: "m-0 text-xs font-medium text-ink",
  footerText: "m-0 text-xs leading-relaxed text-ink-soft",
  hint: "m-0 text-xs leading-relaxed text-ink-soft",
  loginCode: "mt-1 grid gap-2 border border-line bg-surface-soft p-3 text-sm text-ink-soft",
  loginCodeOutput: "text-2xl font-semibold tracking-[0.12em] text-ink",
  connectionGrid: "grid grid-cols-1 items-stretch gap-4 min-[48rem]:grid-cols-2",
  connectionCard: "flex h-full flex-col",
  connectionCardContent: "flex-1 content-start",
  messageExamples:
    "grid gap-3 text-sm leading-relaxed text-ink-soft [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:ps-5",

  heading1: "m-0 text-[clamp(2rem,5vw,3rem)] font-medium leading-none tracking-[-0.04em] text-ink",
  heading2: "m-0 text-xl font-medium leading-tight tracking-[-0.025em] text-ink",
  pageIntro: "py-10",
  introCopy: "max-w-[39rem]",
  eyebrow: "mb-2 text-xs font-medium uppercase tracking-[0.1em] text-ink-soft",
  introText: "m-0 max-w-[36rem] text-sm leading-relaxed text-ink-soft",
  settingsGrid: "grid items-start gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(15rem,0.75fr)]",

  authLayout: "min-h-svh bg-surface text-ink",
  authHeader: "mx-auto w-full max-w-[72rem] px-6 py-7 sm:px-10",
  authLogo:
    "inline-flex items-center gap-3 text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus",
  authLogoMark: "grid size-8 grid-cols-2 place-items-center gap-1 p-1",
  authLogoDot: "size-2 rounded-full bg-ink",
  authLogoName: "text-sm font-medium tracking-tight",
  authHero:
    "mx-auto grid min-h-[calc(100svh-6rem)] w-full max-w-[42rem] place-items-center px-6 pb-16 pt-6 sm:px-10 sm:pb-24",
  authCard: "w-full max-w-[31.75rem] border border-line bg-surface p-6 sm:p-8",
  authKicker: "mb-5 text-xs font-medium uppercase tracking-[0.12em] text-ink-soft",
  authTitle:
    "m-0 max-w-[31rem] text-[clamp(2.5rem,7vw,4rem)] font-medium leading-[0.98] tracking-[-0.055em] text-ink",
  authTitleMuted: "block text-ink-faint",
  authStatus: "mt-4 min-h-5 text-xs text-danger",
  authForm: "grid gap-4",
  authHelp: "m-0 mt-6 max-w-[31.75rem] text-xs leading-relaxed text-ink-soft",
  authTerms: "m-0 mt-5 max-w-[31.75rem] text-xs leading-relaxed text-ink-faint",
  authFooter: "mt-6 text-xs text-ink-soft",

  notice: "border border-line border-s-4 border-s-ink bg-surface-soft p-4 text-sm text-ink-soft",
  noticeWarning: "border-warning/30 border-s-warning bg-warning-soft",
  noticeHeading: "m-0 mb-2 text-sm font-medium text-ink",
  noticeParagraph: "m-0 text-sm leading-relaxed text-ink-soft",
  input:
    "block min-h-10 w-full rounded-control border border-control bg-surface px-3 py-2 text-base text-ink outline-none transition-[background-color,border-color,color] duration-150 placeholder:text-ink-faint hover:border-ink-soft focus:border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-invalid:border-danger sm:min-h-9 sm:text-sm",
  select: "appearance-auto"
} as const
