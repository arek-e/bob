export function isMaintenanceDiscoveryInvocation(argv: readonly string[]): boolean {
  const commandName = findCommandName(argv)
  return (
    argv.length === 0 ||
    commandName === undefined ||
    commandName === "help" ||
    commandName === "context" ||
    argv.some((argument) => argument === "-h" || argument === "--help")
  )
}

function findCommandName(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--context" || argument === "--image") {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--")) return undefined
      index += 1
      continue
    }
    return argument
  }
  return undefined
}
