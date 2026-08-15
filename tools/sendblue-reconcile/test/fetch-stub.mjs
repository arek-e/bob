globalThis.fetch = async (input, init) => {
  const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input

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
