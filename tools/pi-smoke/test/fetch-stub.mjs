globalThis.fetch = async (input, init) => {
  const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input

  if (url === "https://agent-admin.example.test/v1/admin/auth/status") {
    if ((init?.method ?? "GET") !== "GET") {
      return Response.json({ error: "unexpected_write" }, { status: 405 })
    }

    return Response.json({ configured: true, provider: "openai-codex" })
  }

  if (url === "https://agent.example.test/v1/run") {
    const request = JSON.parse(String(init?.body))
    if (
      request.deploymentProfileId !== "core" ||
      !String(request.capabilityCatalogueGeneration).startsWith("capability-v2:")
    ) {
      return Response.json({ code: "deployment_profile_required" }, { status: 409 })
    }
    if (request.userText.includes("Reply only READY")) {
      return Response.json({
        protocolVersion: 1,
        runId: request.runId,
        correlationId: request.correlationId,
        status: "failed",
        errorCode: "invalid_output",
        model: "gpt-5.6-luna",
        durationMs: 25,
        inputTokens: 12,
        outputTokens: 1,
        toolCalls: 0
      })
    }
    return Response.json({
      protocolVersion: 1,
      runId: request.runId,
      correlationId: request.correlationId,
      status: "completed",
      responseText: "READY",
      sourceIds: [],
      conflict: "none",
      model: "gpt-5.6-luna",
      durationMs: 25,
      inputTokens: 12,
      outputTokens: 9,
      toolCalls: 0
    })
  }

  throw new Error(`Unexpected network request: ${url}`)
}
