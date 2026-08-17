export function isSettingsMutationRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (
    /\b(?:do not|don't|never|inte|aldrig|nej|ingen|inget|inga)\b/u.test(normalized) ||
    /^(?:kan|kunde|skulle|bör|borde|ska|får|är|har|gör|gjorde|vill|tycker|vad|vilken|vilket|vilka|hur|varför|när|var)\b/u.test(
      normalized
    )
  ) {
    return false
  }
  const namesSetting =
    /\b(?:time\s*zone|timezone|locale|language|region|time\s*format|12[- ]hour|24[- ]hour|tidszon(?:en)?|språk(?:et)?|svenska|engelska|region(?:en)?|tidsformat(?:et)?|(?:12|24)[- ]?timmars(?:format)?)\b/u.test(
      normalized
    )
  const directsChange =
    /\b(?:set|change|update|switch|use|uppdatera|byt|använd|sätt)\b|(?<![\p{L}\p{N}_])ändra(?![\p{L}\p{N}_])|\bställ\s+in\b/u.test(
      normalized
    )
  return namesSetting && directsChange
}

export function settingsUpdateMatchesRequest(
  text: string,
  input: {
    readonly timeZone?: string
    readonly locale?: string
    readonly hourCycle?: string
  }
): boolean {
  const normalized = text.toLowerCase()
  const timeZoneNamed = /\b(?:time\s*zone|timezone|tidszon(?:en)?)\b/u.test(normalized)
  const localeNamed =
    /\b(?:locale|language|region|språk(?:et)?|svenska|engelska|region(?:en)?)\b/u.test(normalized)
  const hourCycleNamed =
    /\b(?:time\s*format|12[- ]hour|24[- ]hour|tidsformat(?:et)?|(?:12|24)[- ]?timmars(?:format)?)\b/u.test(
      normalized
    )
  const timeZoneMatches = (() => {
    if (input.timeZone === undefined) return true
    const value = input.timeZone.toLowerCase()
    const place = value.split("/").at(-1)?.replaceAll("_", " ")
    return normalized.includes(value) || (place !== undefined && normalized.includes(place))
  })()
  const localeMatches = (() => {
    if (input.locale === undefined) return true
    const value = input.locale.toLowerCase()
    const language = value.split("-")[0]
    if (normalized.includes(value)) return true
    if (language === "sv") return /\b(?:svenska|swedish)\b/u.test(normalized)
    if (language === "en") return /\b(?:engelska|english)\b/u.test(normalized)
    return normalized.includes(value.replaceAll("-", " "))
  })()
  const hourCycleMatches = (() => {
    if (input.hourCycle === undefined) return true
    if (input.hourCycle === "h12") {
      return /\b12[- ]?(?:hour|timmars(?:format)?)\b/u.test(normalized)
    }
    if (input.hourCycle === "h23") {
      return /\b24[- ]?(?:hour|timmars(?:format)?)\b/u.test(normalized)
    }
    return /\b(?:auto|automatic|system default|automatiskt|systemstandard)\b/u.test(normalized)
  })()
  return (
    (input.timeZone === undefined || (timeZoneNamed && timeZoneMatches)) &&
    (input.locale === undefined || (localeNamed && localeMatches)) &&
    (input.hourCycle === undefined || (hourCycleNamed && hourCycleMatches))
  )
}
