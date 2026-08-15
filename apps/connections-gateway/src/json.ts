export type JsonValue = null | boolean | number | string | JsonObject | JsonValue[]

export interface JsonObject {
  readonly [key: string]: JsonValue
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && !Array.isArray(value) && Object(value) === value
}

export function requiredJsonObject(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) throw new Error("invalid_request")
  return value
}

export function requiredText(value: JsonValue | undefined): string {
  if (
    Object.prototype.toString.call(value) !== "[object String]" ||
    String(value).length === 0 ||
    String(value).length > 200
  ) {
    throw new Error("invalid_request")
  }
  return String(value)
}
