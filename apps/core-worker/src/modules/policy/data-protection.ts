export interface WrappedDataKey {
  readonly ciphertext: string
  readonly iv: string
  readonly version: number
}

export interface EncryptedText {
  readonly ciphertext: string
  readonly iv: string
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function toBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function createDataProtection(
  kekKeyring: Readonly<Record<number, string>>,
  activeVersion: number,
  lookupKeyBase64: string
) {
  const kekPromises = new Map<number, Promise<CryptoKey>>()
  let lookupKeyPromise: Promise<CryptoKey> | undefined

  function kek(version: number): Promise<CryptoKey> {
    const encoded = kekKeyring[version]
    if (encoded === undefined) throw new Error(`Missing data KEK version: ${version}`)
    const existing = kekPromises.get(version)
    if (existing !== undefined) return existing
    const imported = crypto.subtle.importKey(
      "raw",
      fromBase64(encoded),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    )
    kekPromises.set(version, imported)
    return imported
  }

  async function createWrappedDataKey(): Promise<{ key: CryptoKey; wrapped: WrappedDataKey }> {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt"
    ])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await kek(activeVersion),
      raw
    )
    return {
      key,
      wrapped: { ciphertext: toBase64(ciphertext), iv: toBase64(iv), version: activeVersion }
    }
  }

  async function unwrapDataKey(wrapped: WrappedDataKey): Promise<CryptoKey> {
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(wrapped.iv) },
      await kek(wrapped.version),
      fromBase64(wrapped.ciphertext)
    )
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
  }

  async function encryptText(key: CryptoKey, value: string): Promise<EncryptedText> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(value)
    )
    return { ciphertext: toBase64(ciphertext), iv: toBase64(iv) }
  }

  async function decryptText(key: CryptoKey, value: EncryptedText): Promise<string> {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(value.iv) },
      key,
      fromBase64(value.ciphertext)
    )
    return new TextDecoder().decode(plain)
  }

  async function hashLookup(value: string): Promise<string> {
    lookupKeyPromise ??= crypto.subtle.importKey(
      "raw",
      fromBase64(lookupKeyBase64),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
    const signature = await crypto.subtle.sign(
      "HMAC",
      await lookupKeyPromise,
      new TextEncoder().encode(value)
    )
    return toBase64(signature)
  }

  async function contentHash(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    return toBase64(digest)
  }

  return { createWrappedDataKey, unwrapDataKey, encryptText, decryptText, hashLookup, contentHash }
}

export type DataProtection = ReturnType<typeof createDataProtection>
