const toBase64 = (value: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(value)))

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

const additionalData = (routeId: string, providerEventKey: string, keyVersion: string) =>
  new TextEncoder().encode(`${routeId}\u0000${providerEventKey}\u0000${keyVersion}`)

export interface ProtectedStagedPayload {
  readonly ciphertext: string
  readonly iv: string
  readonly keyVersion: string
}

/** Protects staged channel content and binds it to its route and provider event. */
export function createStagedPayloadProtection(encodedKey: string, keyVersion: string) {
  const key = crypto.subtle.importKey("raw", fromBase64(encodedKey), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt"
  ])
  return {
    async encrypt(
      routeId: string,
      providerEventKey: string,
      plaintext: string
    ): Promise<ProtectedStagedPayload> {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: additionalData(routeId, providerEventKey, keyVersion)
        },
        await key,
        new TextEncoder().encode(plaintext)
      )
      return { ciphertext: toBase64(ciphertext), iv: toBase64(iv.buffer), keyVersion }
    },
    async decrypt(
      routeId: string,
      providerEventKey: string,
      protectedPayload: ProtectedStagedPayload
    ): Promise<string> {
      if (protectedPayload.keyVersion !== keyVersion)
        throw new Error("Staged channel event key version is unavailable")
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64(protectedPayload.iv),
          additionalData: additionalData(routeId, providerEventKey, keyVersion)
        },
        await key,
        fromBase64(protectedPayload.ciphertext)
      )
      return new TextDecoder().decode(plaintext)
    }
  }
}
