/**
 * Application Storage has no shared raw SQL Interface.
 *
 * Each owning Module keeps its domain operations. Import a concrete Runtime
 * Adapter from `./postgresql.ts` only at the hosting seam.
 */
export {}
