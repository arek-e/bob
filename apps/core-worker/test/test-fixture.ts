export type TestFixture<T> = {
  readonly [Key in keyof T]?: T[Key] extends object ? TestFixture<T[Key]> : T[Key]
}

export function testFixture<T>(value: TestFixture<T>): T {
  // SAFETY: A focused test double implements every member exercised by its test.
  return value as T
}
