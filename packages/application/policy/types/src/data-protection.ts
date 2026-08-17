export interface WrappedDataKey {
  readonly ciphertext: string
  readonly iv: string
  readonly version: number
}

export interface EncryptedText {
  readonly ciphertext: string
  readonly iv: string
}

export interface EncryptedBytes {
  readonly ciphertext: Uint8Array
  readonly iv: string
}

export interface DataProtection {
  readonly createWrappedDataKey: () => Promise<{
    readonly key: CryptoKey
    readonly wrapped: WrappedDataKey
  }>
  readonly unwrapDataKey: (wrapped: WrappedDataKey) => Promise<CryptoKey>
  readonly encryptText: (key: CryptoKey, value: string) => Promise<EncryptedText>
  readonly decryptText: (key: CryptoKey, value: EncryptedText) => Promise<string>
  readonly encryptBytes: (key: CryptoKey, value: Uint8Array) => Promise<EncryptedBytes>
  readonly decryptBytes: (key: CryptoKey, value: EncryptedBytes) => Promise<Uint8Array>
  readonly hashLookup: (value: string) => Promise<string>
  readonly contentHash: (value: string) => Promise<string>
  readonly contentHashBytes: (value: Uint8Array) => Promise<string>
}
