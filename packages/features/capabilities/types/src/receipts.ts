import { Schema } from "effect"

import { ToolName } from "./tools.ts"

export const PriorToolReceiptOrigin = Schema.Literals(["same_turn", "predecessor_turn"])

export const PriorToolReceipt = Schema.Struct({
  origin: PriorToolReceiptOrigin,
  toolName: ToolName,
  actionOutcome: Schema.Literals(["confirmed", "proposed", "unknown"])
})

export type PriorToolReceiptOrigin = typeof PriorToolReceiptOrigin.Type
export type PriorToolReceipt = typeof PriorToolReceipt.Type
