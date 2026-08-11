import type { SettingsConnection } from "@bob/contracts/settings"

import { and, eq } from "drizzle-orm"

import type { CoreDatabase } from "../../database.ts"

import { channels } from "./schema.ts"

export async function readSendblueConnectionStatus(
  database: CoreDatabase,
  ownerId: string
): Promise<SettingsConnection> {
  const [channel] = await database
    .select({ id: channels.id, optedOutAt: channels.optedOutAt })
    .from(channels)
    .where(and(eq(channels.userId, ownerId), eq(channels.provider, "sendblue")))
    .limit(1)

  return {
    provider: "sendblue",
    status:
      channel === undefined ? "not_connected" : channel.optedOutAt === null ? "connected" : "paused"
  }
}
