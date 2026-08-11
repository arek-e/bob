const BACKUP_NAME = /^bob-.*\.json\.gz\.age$/u

export function expiredBackupNames(
  names: readonly string[],
  retentionCount: number
): readonly string[] {
  if (!Number.isSafeInteger(retentionCount) || retentionCount < 1) {
    throw new Error("Backup retention count must be a positive integer")
  }
  return names
    .filter((name) => BACKUP_NAME.test(name))
    .sort((left, right) => right.localeCompare(left))
    .slice(retentionCount)
}
