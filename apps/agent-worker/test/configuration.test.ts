import { describe, expect, it } from "vitest"

import { readAgentConfiguration } from "../src/configuration.ts"

describe("agent configuration", () => {
  it("decodes process environment strings", () => {
    const configuration = readAgentConfiguration({
      PORT: "8787",
      BAO_ADDR: "https://openbao.example.invalid/",
      BAO_AUTH_METHOD: "kubernetes",
      BAO_KUBERNETES_ROLE: "bob-agent",
      BAO_KUBERNETES_JWT_PATH: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      BOB_PROVIDER: "openai-codex",
      BOB_MODEL: "gpt-5.6-luna",
      BOB_ALLOWED_MODELS: "gpt-5.6-luna,gpt-5.6-terra",
      BOB_RELEASE_SHA: "f974ae0fc5b53ca1c233faa0dfd69e9f814cb25f",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example.invalid:4318/",
      CORE_URL: "https://bob.example.invalid/",
      RUNTIME_SHARED_SECRET: "runtime-shared-secret-value-1234567890",
      CORE_CALLER_SECRET: "core-caller-secret-value-123456789012",
      JOB_QUEUE_URL: "redis://localhost:6379",
      AGENT_EXECUTION_POOL_ID: "core-v1",
      AGENT_MAX_CONCURRENCY: "4"
    })

    expect(configuration.baoAddress).toBe("https://openbao.example.invalid")
    expect(configuration.coreUrl).toBe("https://bob.example.invalid")
    expect(configuration.otlpEndpoint).toBe("http://collector.example.invalid:4318")
    expect(configuration.port).toBe(8787)
    expect(configuration.releaseSha).toBe("f974ae0fc5b53ca1c233faa0dfd69e9f814cb25f")
    expect(configuration.allowedModels).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"])
    expect(configuration.baoAuthentication).toEqual({
      method: "kubernetes",
      role: "bob-agent",
      jwtPath: "/var/run/secrets/kubernetes.io/serviceaccount/token"
    })
  })

  it("decodes file-backed AppRole configuration", () => {
    const configuration = readAgentConfiguration({
      PORT: "8787",
      BAO_ADDR: "https://openbao.example.invalid/",
      BAO_AUTH_METHOD: "approle",
      BAO_APPROLE_ROLE_ID: "role-id",
      BAO_APPROLE_SECRET_ID_PATH: "/run/secrets/openbao_approle_secret_id",
      BOB_PROVIDER: "openai-codex",
      BOB_MODEL: "gpt-5.6-luna",
      BOB_ALLOWED_MODELS: "gpt-5.6-luna",
      BOB_RELEASE_SHA: "f974ae0fc5b53ca1c233faa0dfd69e9f814cb25f",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example.invalid:4318/",
      CORE_URL: "https://bob.example.invalid/",
      RUNTIME_SHARED_SECRET: "runtime-shared-secret-value-1234567890",
      CORE_CALLER_SECRET: "core-caller-secret-value-123456789012",
      JOB_QUEUE_URL: "redis://localhost:6379",
      AGENT_EXECUTION_POOL_ID: "core-v1",
      AGENT_MAX_CONCURRENCY: "4"
    })

    expect(configuration.baoAuthentication).toEqual({
      method: "approle",
      roleId: "role-id",
      secretIdPath: "/run/secrets/openbao_approle_secret_id"
    })
  })

  it("decodes environment-backed AppRole configuration", () => {
    const configuration = readAgentConfiguration({
      PORT: "8787",
      BAO_ADDR: "https://openbao.example.invalid/",
      BAO_AUTH_METHOD: "approle",
      BAO_APPROLE_ROLE_ID: "role-id",
      BAO_APPROLE_SECRET_ID: "secret-id",
      BOB_PROVIDER: "openai-codex",
      BOB_MODEL: "gpt-5.6-luna",
      BOB_ALLOWED_MODELS: "gpt-5.6-luna",
      BOB_RELEASE_SHA: "f974ae0fc5b53ca1c233faa0dfd69e9f814cb25f",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example.invalid:4318/",
      CORE_URL: "https://bob.example.invalid/",
      RUNTIME_SHARED_SECRET: "runtime-shared-secret-value-1234567890",
      CORE_CALLER_SECRET: "core-caller-secret-value-123456789012",
      JOB_QUEUE_URL: "redis://localhost:6379",
      AGENT_EXECUTION_POOL_ID: "core-v1",
      AGENT_MAX_CONCURRENCY: "4"
    })

    expect(configuration.baoAuthentication).toEqual({
      method: "approle",
      roleId: "role-id",
      secretId: "secret-id"
    })
  })

  it("requires and normalizes the opt-in LiteLLM gateway", () => {
    const configuration = readAgentConfiguration({
      PORT: "8787",
      BAO_ADDR: "https://openbao.example.invalid/",
      BAO_AUTH_METHOD: "approle",
      BAO_APPROLE_ROLE_ID: "role-id",
      BAO_APPROLE_SECRET_ID_PATH: "/run/secrets/openbao_approle_secret_id",
      BOB_PROVIDER: "litellm",
      BOB_MODEL: "gpt-5.4",
      BOB_ALLOWED_MODELS: "gpt-5.4",
      BOB_GATEWAY_BASE_URL: "https://ai-gateway.example.invalid/v1/",
      BOB_GATEWAY_API_KEY: "test-virtual-key",
      BOB_RELEASE_SHA: "f974ae0fc5b53ca1c233faa0dfd69e9f814cb25f",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example.invalid:4318/",
      CORE_URL: "https://bob.example.invalid/",
      RUNTIME_SHARED_SECRET: "runtime-shared-secret-value-1234567890",
      CORE_CALLER_SECRET: "core-caller-secret-value-123456789012",
      JOB_QUEUE_URL: "redis://localhost:6379",
      AGENT_EXECUTION_POOL_ID: "core-v1",
      AGENT_MAX_CONCURRENCY: "4"
    })

    expect(configuration.provider).toBe("litellm")
    expect(configuration.gateway).toEqual({
      baseUrl: "https://ai-gateway.example.invalid/v1",
      apiKey: "test-virtual-key"
    })
  })

  it("rejects an incomplete LiteLLM gateway", () => {
    expect(() =>
      readAgentConfiguration({
        PORT: "8787",
        BAO_ADDR: "https://openbao.example.invalid/",
        BAO_AUTH_METHOD: "approle",
        BAO_APPROLE_ROLE_ID: "role-id",
        BAO_APPROLE_SECRET_ID_PATH: "/run/secrets/openbao_approle_secret_id",
        BOB_PROVIDER: "litellm",
        BOB_MODEL: "gpt-5.4",
        BOB_ALLOWED_MODELS: "gpt-5.4",
        BOB_RELEASE_SHA: "f974ae0fc5b53ca1c233faa0dfd69e9f814cb25f",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example.invalid:4318/",
        CORE_URL: "https://bob.example.invalid/",
        RUNTIME_SHARED_SECRET: "runtime-shared-secret-value-1234567890",
        CORE_CALLER_SECRET: "core-caller-secret-value-123456789012",
        JOB_QUEUE_URL: "redis://localhost:6379",
        AGENT_EXECUTION_POOL_ID: "core-v1",
        AGENT_MAX_CONCURRENCY: "4"
      })
    ).toThrow("BOB_GATEWAY_BASE_URL")
  })
})
