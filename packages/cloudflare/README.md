# Cloudflare compatibility packages

These packages retain Bob's Cloudflare Runtime Adapters during the portable-runtime migration.

They are not primary applications. Infrastructure plans can still deploy their Worker entrypoints.

The Core and Channel portable apps still use some Worker-shaped exports as migration bridges. Move
those shared Implementations behind provider-neutral Interfaces before removing these packages.

Do not run a Cloudflare Adapter and a portable Adapter as concurrent authorities for one Bob
Instance.
