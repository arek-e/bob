globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url

  if (url === "https://agent-admin.example.test/v1/admin/auth/status") {
    if ((init?.method ?? "GET") !== "GET") {
      return Response.json({ error: "unexpected_write" }, { status: 405 })
    }

    return Response.json({ configured: true, provider: "openai-codex" })
  }

  throw new Error(`Unexpected network request: ${url}`)
}
