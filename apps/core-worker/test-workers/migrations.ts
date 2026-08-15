export interface TestMigration {
  readonly name: string
  readonly queries: readonly string[]
}

export function decodeTestMigrations(value: string): TestMigration[] {
  // SAFETY: This controlled test fixture matches the asserted contract used by this test.
  return JSON.parse(value) as TestMigration[]
}
