# Managed Channel Router

This Worker receives authorized first events before a Bob Instance exists.

It keeps sender routes and staged events in D1. A keyed HMAC protects sender lookup. AES-GCM protects
each staged payload. The Router sends only an opaque Provisioning Subject to the Control Plane.

The Worker requests one managed Instance. It retries until the Instance is ready. It then sends the
staged event through the managed Runtime ingress binding.

Unknown senders cannot request infrastructure. The sender lookup uses keyed HMAC. The Control Plane
never receives a phone number or message.

Production infrastructure must provide these bindings:

- `ROUTES`: D1 database with `migrations/0001_managed_channel_router.sql`
- `DELIVERY_QUEUE`: queue with a dead-letter queue and retention longer than cold activation
- `RUNTIME_INGRESS`: authenticated managed ingress gateway

Use a scoped Control Plane token. It must permit only managed Instance creation and Instance state
reads.

The Runtime ingress must deduplicate `NormalizedInboundEvent.id`. A Worker retry can occur after the
ingress accepts an event but before D1 records completion.
