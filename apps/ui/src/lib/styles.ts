export const styles = {
  routeLoading: "grid min-h-svh place-items-center p-8 text-sm text-ink-soft",
  appFrame: "flex min-h-svh min-w-80 bg-canvas font-sans text-ink antialiased",
  skipLink:
    "fixed left-3 top-3 z-50 rounded-control bg-surface px-3 py-2 text-sm font-semibold text-ink no-underline outline-none -translate-y-[160%] transition-transform duration-150 focus:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  sidebar:
    "sticky top-0 flex min-h-svh w-[15.75rem] shrink-0 flex-col border-r border-line bg-surface p-3 max-[50rem]:hidden",
  sidebarHeader: "grid gap-4 px-1 pb-5",
  brand:
    "inline-flex items-center gap-3 px-1 py-1 text-ink no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  brandMark:
    "grid size-7 place-items-center rounded-control bg-accent text-xs font-extrabold text-white",
  brandName: "text-sm font-extrabold tracking-tight",
  workspaceSwitch:
    "flex min-h-8 items-center gap-2 rounded-control bg-surface-soft px-2 text-left text-xs font-bold text-ink-soft hover:bg-surface-tint hover:text-ink",
  workspaceSwitchDot: "size-3 shrink-0 rounded-[0.2rem] border-2 border-success-soft bg-success",
  sidebarLabel:
    "mb-2 ml-2 mt-2 text-[0.68rem] font-extrabold uppercase tracking-[0.08em] text-ink-faint",
  sidebarLabelSecondary: "mt-6",
  sidebarNav: "grid gap-1",
  navLink:
    "flex min-h-9 items-center gap-2.5 rounded-control border-l-2 border-transparent px-2.5 py-2 text-xs font-semibold text-ink-soft no-underline transition-[color,background-color,border-color] duration-150 hover:bg-surface-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  navLinkActive: "border-accent bg-surface-tint font-bold text-ink",
  navLinkMuted: "text-ink-faint",
  navIcon: "size-4 text-ink-faint",
  navIconActive: "text-accent",
  sidebarSpacer: "flex-1",
  sidebarAdd:
    "mb-1 flex min-h-9 items-center gap-2 rounded-control px-2 text-xs font-bold text-ink-soft no-underline hover:bg-accent-soft hover:text-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  sidebarAddIcon:
    "grid size-5 place-items-center rounded-[0.4rem] border border-line-strong bg-surface text-accent",
  sidebarAccount: "mt-2 flex items-center gap-2 border-t border-line px-1.5 py-3 text-ink",
  avatar:
    "grid size-7 shrink-0 place-items-center rounded-full bg-avatar text-xs font-extrabold text-avatar-ink",
  accountCopy: "grid min-w-0 gap-0.5",
  accountName: "truncate text-xs font-bold",
  accountEmail: "truncate text-[0.68rem] text-ink-faint",
  appContent: "min-w-0 flex-1 bg-canvas",
  topbar: "flex min-h-14 items-center border-b border-line bg-surface px-4 lg:px-9",
  topbarInner: "mx-auto flex w-full max-w-[88rem] items-center justify-between gap-4",
  topbarPage: "flex min-w-0 items-center gap-2",
  topbarPageIcon:
    "grid size-7 place-items-center rounded-control border border-line bg-accent-soft text-accent",
  topbarPageTitle: "text-xs font-bold text-ink",
  topbarPageMuted: "pl-1 text-xs text-ink-faint max-[38rem]:hidden",
  topbarActions: "ml-auto flex items-center gap-3",
  topbarDate: "text-xs text-ink-faint max-[38rem]:hidden",
  topbarDivider: "h-4 w-px bg-line",
  topbarAvatar:
    "grid size-7 place-items-center rounded-full bg-avatar text-[0.68rem] font-extrabold text-avatar-ink",
  topbarSignout:
    "inline-flex min-h-8 items-center gap-1.5 rounded-control border border-transparent px-2 text-xs font-bold text-ink-soft transition-[color,background-color,border-color] duration-150 hover:border-line hover:bg-surface-tint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  workspaceBody: "mx-auto grid w-full max-w-[88rem] grid-cols-1 items-start",
  workspaceBodyWithInspector: "lg:grid-cols-[minmax(0,1fr)_15.5rem]",
  mainContent:
    "min-w-0 min-h-[calc(100svh-3.5rem)] border-x border-line bg-surface px-4 pb-20 pt-2 sm:px-6 lg:px-14",
  statusRegion: "min-h-5 mb-1 text-xs font-bold text-accent",
  statusRegionError: "text-danger",
  inspector:
    "sticky top-3 mx-3 mt-3 min-w-0 rounded-panel border border-line bg-surface p-3 max-lg:hidden",
  inspectorTabs: "mb-5 flex gap-4 border-b border-line pb-2.5",
  inspectorTab: "relative text-[0.7rem] font-bold text-ink-faint",
  inspectorTabActive:
    "text-ink after:absolute after:inset-x-0 after:-bottom-3 after:h-0.5 after:rounded-full after:bg-accent",
  inspectorKicker: "mb-1 text-[0.66rem] font-extrabold uppercase tracking-[0.08em] text-ink-faint",
  inspectorTitle: "mb-3 text-xs font-bold tracking-tight text-ink",
  inspectorRow:
    "flex min-h-8 items-center gap-2 rounded-[0.4rem] px-2 py-1.5 text-xs text-ink-soft no-underline hover:bg-accent-soft hover:text-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  inspectorRowArrow: "ml-auto text-ink-faint",
  inspectorDivider: "my-4 h-px bg-line",
  inspectorNote: "flex items-center gap-2 text-xs font-bold text-ink",
  inspectorNoteDot: "size-3 rounded-full border-2 border-success-soft bg-success",
  inspectorCopy: "mt-2 text-[0.68rem] leading-relaxed text-ink-faint",
  pageIntro:
    "flex items-end justify-between gap-8 py-9 pb-6 max-[50rem]:flex-col max-[50rem]:items-start max-[50rem]:gap-5",
  introCopy: "max-w-[39rem]",
  eyebrow: "mb-2 text-[0.7rem] font-extrabold uppercase tracking-[0.13em] text-accent",
  heading1:
    "m-0 mb-2 text-[clamp(2rem,4vw,3rem)] font-semibold leading-none tracking-[-0.035em] text-ink",
  heading2:
    "m-0 text-[clamp(1.45rem,2.4vw,1.9rem)] font-semibold leading-tight tracking-[-0.035em] text-ink",
  heading3: "m-0 mb-1 text-[1.05rem] font-semibold leading-tight tracking-[-0.025em] text-ink",
  heading4: "m-0 mb-1 text-base font-semibold tracking-[-0.025em] text-ink",
  introText: "m-0 max-w-[36rem] text-sm text-ink-soft",
  sectionNav: "flex flex-wrap justify-end gap-1 max-[50rem]:justify-start",
  sectionNavLink:
    "rounded-control px-2.5 py-1.5 text-xs font-bold text-ink-soft no-underline hover:bg-surface-tint hover:text-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  dashboardStack: "grid gap-14",
  contentSection: "scroll-mt-4",
  sectionHeading:
    "mb-4 flex items-end justify-between gap-3 max-[38rem]:flex-col max-[38rem]:items-start",
  actionRow: "flex items-center gap-2 max-[38rem]:flex-wrap",
  cardHeadingRow: "flex items-start justify-between gap-3",
  cardGrid: "grid grid-cols-1 items-start gap-4 md:grid-cols-2",
  loadingState:
    "col-span-full rounded-control border border-dashed border-line-strong bg-surface-soft p-6 text-sm text-ink-soft",
  detailList: "m-0 list-disc space-y-1.5 pl-5 text-xs text-ink-soft",
  hint: "m-0 text-xs text-ink-soft",
  date: "m-0 text-xs text-ink-soft",
  state: "m-0 text-xs text-ink-soft",
  tags: "m-0 text-xs text-ink-soft",
  sectionIntro: "mb-4 text-sm text-ink-soft",
  uiCard: "min-w-0 rounded-panel border border-line bg-surface p-4",
  uiCardHeader: "grid gap-1",
  uiCardTitle: "m-0 text-base font-semibold leading-tight tracking-[-0.025em] text-ink",
  uiCardDescription: "m-0 text-xs text-ink-soft",
  uiCardContent: "mt-3 text-sm text-ink-soft",
  uiCardFooter: "mt-4",
  formCard: "grid gap-5 rounded-panel border border-line bg-surface p-4",
  formIntro: "m-0 text-sm text-ink-soft",
  fieldGroup: "grid gap-2",
  fieldLabel: "text-xs font-extrabold text-ink",
  fieldError: "m-0 text-xs font-bold text-danger",
  searchPanel:
    "mb-8 grid items-end gap-4 rounded-panel border border-line bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_auto]",
  trainingOverview: "grid gap-10",
  trainingGroup: "grid gap-4",
  subsectionHeading: "flex items-center gap-3",
  subsectionHeadingSpaced: "mt-12 mb-4",
  subsectionTitle: "m-0 text-xs font-extrabold uppercase tracking-[0.08em] text-ink-soft",
  subsectionRule: "h-px flex-1 bg-line",
  proposalDetails:
    "m-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-control border border-line bg-surface-soft p-3 font-mono text-xs text-ink-soft",
  detailsPanel: "mt-4 border-t border-line",
  inlineForm: "grid gap-2 pt-3",
  editForm: "mt-4 border-t border-line pt-4",
  privateText:
    "mt-4 max-w-full whitespace-pre-wrap break-words rounded-control border border-line bg-surface-soft p-3 text-sm leading-relaxed text-ink-soft",
  loginCode:
    "mt-3 grid gap-2 rounded-control border border-line bg-surface-soft p-3 text-sm text-ink-soft",
  loginCodeOutput: "text-2xl font-extrabold tracking-[0.12em] text-ink",
  settingsGrid: "grid items-start gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(15rem,0.75fr)]",
  connectionGrid: "grid grid-cols-1 items-start gap-4 md:grid-cols-2",
  connectionCard: "grid gap-1",
  messageExamples: "text-sm text-ink-soft",
  authLayout: "min-h-svh bg-surface text-ink",
  authHeader: "mx-auto w-full max-w-[90rem] px-6 py-7 sm:px-10 lg:px-12",
  authLogo:
    "inline-flex items-center gap-3 rounded-control text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent",
  authLogoMark: "grid size-8 grid-cols-2 place-items-center gap-1 p-1",
  authLogoDot: "size-2 rounded-full bg-ink",
  authLogoName: "text-sm font-semibold tracking-tight",
  authHero:
    "mx-auto grid min-h-[calc(100svh-6rem)] w-full max-w-[90rem] grid-cols-1 items-center gap-14 px-6 pb-16 pt-10 sm:px-10 lg:grid-cols-[minmax(20rem,0.72fr)_minmax(0,1.28fr)] lg:gap-16 lg:px-12 lg:pb-24 lg:pt-6",
  authCard: "w-full max-w-[31.75rem] justify-self-center lg:justify-self-start",
  authKicker: "mb-5 text-xs font-semibold uppercase tracking-[0.12em] text-ink-soft",
  authTitle:
    "m-0 max-w-[31rem] text-[clamp(2.5rem,4.8vw,4rem)] font-semibold leading-[0.98] tracking-[-0.055em] text-ink",
  authTitleMuted: "block text-ink-faint",
  authStatus: "min-h-5 mt-4 text-xs text-danger",
  authForm: "grid gap-4",
  authHelp: "m-0 mt-6 max-w-[31.75rem] text-xs leading-relaxed text-ink-soft",
  authTerms: "m-0 mt-5 max-w-[31.75rem] text-xs leading-relaxed text-ink-faint",
  authFooter: "mt-6 text-xs text-ink-soft",
  authPreview:
    "hidden min-h-[34rem] overflow-hidden rounded-panel border border-preview-line bg-preview-bg text-white lg:block lg:min-h-[min(68svh,60rem)]",
  authPreviewTopbar:
    "flex min-h-12 items-center justify-between border-b border-preview-line px-4 text-[0.68rem] text-white/60",
  authPreviewBrand: "flex items-center gap-2 font-semibold text-white/90",
  authPreviewBrandMark:
    "grid size-5 place-items-center rounded-[0.3rem] bg-white text-[0.6rem] font-extrabold text-preview-bg",
  authPreviewBody: "grid min-h-[calc(34rem-3rem)] grid-cols-[8.5rem_minmax(0,1fr)] gap-4 p-4",
  authPreviewRail:
    "flex min-h-0 flex-col gap-1 rounded-control bg-preview-rail p-3 text-[0.65rem] text-white/55",
  authPreviewRailHeader: "mb-4 flex items-center gap-2 text-white/90",
  authPreviewRailAvatar:
    "grid size-5 place-items-center rounded-full bg-preview-card-warm text-[0.55rem] text-white",
  authPreviewRailLabel:
    "mb-2 px-2 text-[0.56rem] font-semibold uppercase tracking-[0.12em] text-white/35",
  authPreviewRailItem: "rounded-[0.35rem] px-2 py-1.5",
  authPreviewRailItemActive: "bg-preview-card text-white/90",
  authPreviewRailSpacer: "flex-1",
  authPreviewMain: "grid min-w-0 content-start gap-5 p-2 sm:p-4",
  authPreviewIntro: "grid gap-1",
  authPreviewKicker: "text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-white/35",
  authPreviewTitle: "text-xl font-semibold tracking-[-0.035em] text-white/90 sm:text-2xl",
  authPreviewSubtitle: "text-xs text-white/45",
  authPreviewCards: "grid grid-cols-1 gap-3 sm:grid-cols-3",
  authPreviewCard:
    "min-h-40 rounded-control border border-preview-line p-3 text-white/85 sm:min-h-48",
  authPreviewCardWarm: "bg-preview-card-warm",
  authPreviewCardGreen: "bg-preview-card-green",
  authPreviewCardDark: "bg-preview-card",
  authPreviewCardLabel: "text-[0.56rem] font-semibold uppercase tracking-[0.12em] text-white/55",
  authPreviewCardTitle: "mt-3 text-sm font-semibold leading-tight",
  authPreviewCardText: "mt-2 text-[0.68rem] leading-relaxed text-white/55",
  authPreviewCardMedia: "mt-5 h-16 rounded-[0.35rem] border border-white/10 bg-black/20",
  authPreviewNote:
    "flex items-center justify-between gap-3 rounded-control border border-preview-line bg-preview-card p-3 text-xs text-white/70",
  authPreviewNoteLine: "h-1.5 flex-1 rounded-full bg-white/10",
  emptyState: "min-h-32 flex items-center",
  notice:
    "mb-4 rounded-control border border-line border-l-4 border-l-accent bg-surface-soft p-3 text-sm text-ink-soft",
  noticeWarning: "border-warning/30 border-l-warning bg-warning-soft",
  noticeHeading: "m-0 mb-2 text-sm font-semibold text-ink",
  noticeParagraph: "m-0 text-sm text-ink-soft",
  input:
    "block min-h-10 w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none transition-[border-color] duration-150 placeholder:text-ink-faint hover:border-ink-soft focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  textarea: "min-h-28 resize-y",
  select: "appearance-auto",
  reduceMotion: "motion-reduce:transition-none"
} as const
