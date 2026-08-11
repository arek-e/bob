export interface TestMigration {
  readonly name: string
  readonly queries: readonly string[]
}

export function decodeTestMigrations(value: string): TestMigration[] {
  return JSON.parse(value) as TestMigration[]
}
