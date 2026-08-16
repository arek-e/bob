globalThis.fetch = async (input, init) => {
  const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers)

  if (url === "https://agent-admin.example.test/v1/admin/auth/status") {
    if ((init?.method ?? "GET") !== "GET") {
      return Response.json({ error: "unexpected_write" }, { status: 405 })
    }

    if (
      headers.get("CF-Access-Client-Id") !== "test-admin-client" ||
      headers.get("CF-Access-Client-Secret") !== "test-admin-secret"
    ) {
      return Response.json({ code: "unauthorized" }, { status: 401 })
    }

    return Response.json({ configured: true, provider: "openai-codex" })
  }

  if (url === "https://agent-admin.example.test/v1/admin/smoke") {
    if (
      headers.get("CF-Access-Client-Id") !== "test-admin-client" ||
      headers.get("CF-Access-Client-Secret") !== "test-admin-secret"
    ) {
      return Response.json({ code: "unauthorized" }, { status: 401 })
    }
    if (init?.method !== "POST" || init.body !== undefined) {
      return Response.json({ code: "invalid_request" }, { status: 400 })
    }
    return Response.json({
      protocolVersion: 1,
      status: "completed",
      model: "gpt-5.6-luna",
      durationMs: 25
    })
  }

  throw new Error(`Unexpected network request: ${url}`)
}
