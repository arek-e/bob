import { Schema } from "effect"

export const JsonObject = Schema.Record(Schema.String, Schema.Json)

export function jsonObject<Input>(value: Input): typeof JsonObject.Type {
  return Schema.decodeUnknownSync(JsonObject)(JSON.parse(JSON.stringify(value)))
}
