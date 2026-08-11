globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url

  if (url === "https://sendblue.example.test/health") {
    return Response.json({ healthy: true, service: "sendblue-ingress", version: 1 })
  }

  if (url === "https://api.sendblue.com/api/status?handle=provider-1") {
    return Response.json({
      message_handle: "provider-1",
      status: "DELIVERED",
      date_updated: "2026-08-11T10:02:00.000Z"
    })
  }

  if (url === "https://api.sendblue.com/api/account/webhooks") {
    if ((init?.method ?? "GET") !== "GET") {
      return Response.json({ error: "unexpected_write" }, { status: 405 })
    }

    return Response.json({
      webhooks: {
        receive: ["https://sendblue.example.test/webhooks/receive"],
        outbound: ["https://sendblue.example.test/webhooks/outbound"],
        globalSecret: "test-signing-secret"
      }
    })
  }

  throw new Error(`Unexpected network request: ${url}`)
}
