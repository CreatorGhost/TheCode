import { expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderError } from "@/provider/error"

test("parseAPICallError extracts OpenAI-shaped error.message", () => {
  const error = new APICallError({
    message: "Too Many Requests",
    statusCode: 429,
    url: "https://api.openai.com/v1/chat/completions",
    requestBodyValues: {},
    responseBody: JSON.stringify({
      error: {
        message: "Rate limit exceeded",
        type: "rate_limit_error",
      },
    }),
    isRetryable: true,
  })

  const parsed = ProviderError.parseAPICallError({
    providerID: ProviderV2.ID.make("openai"),
    error,
  })

  expect(parsed.type).toBe("api_error")
  expect(parsed.message).toBe("Too Many Requests: Rate limit exceeded")
})

test("parseAPICallError still extracts string body.error", () => {
  const error = new APICallError({
    message: "Bad Request",
    statusCode: 400,
    url: "https://example.com/v1/chat",
    requestBodyValues: {},
    responseBody: JSON.stringify({
      error: "model not found",
    }),
    isRetryable: false,
  })

  const parsed = ProviderError.parseAPICallError({
    providerID: ProviderV2.ID.make("openai"),
    error,
  })

  expect(parsed.type).toBe("api_error")
  expect(parsed.message).toBe("Bad Request: model not found")
})

test("parseAPICallError surfaces a real message that merely mentions <html>", () => {
  const error = new APICallError({
    message: "Invalid request: unexpected <html> tag in prompt content",
    statusCode: 400,
    url: "https://example.com/v1/chat",
    requestBodyValues: {},
    isRetryable: false,
  })

  const parsed = ProviderError.parseAPICallError({
    providerID: ProviderV2.ID.make("openai"),
    error,
  })

  // Anchored HTML detection must NOT misclassify this as a gateway page.
  expect(parsed.message).toBe("Invalid request: unexpected <html> tag in prompt content")
})

test("parseAPICallError replaces an HTML gateway body with a friendly 401 message", () => {
  const error = new APICallError({
    message: "Unauthorized",
    statusCode: 401,
    url: "https://gateway.example.com/v1/chat",
    requestBodyValues: {},
    responseBody: "<!doctype html><html><body>401 Unauthorized</body></html>",
    isRetryable: false,
  })

  const parsed = ProviderError.parseAPICallError({
    providerID: ProviderV2.ID.make("openai"),
    error,
  })

  expect(parsed.message).not.toContain("<html")
  expect(parsed.message).toContain("dcode auth login")
})

test("parseAPICallError does not swallow a genuine JSON error on 503", () => {
  const error = new APICallError({
    message: "Service Unavailable",
    statusCode: 503,
    url: "https://example.com/v1/chat",
    requestBodyValues: {},
    responseBody: JSON.stringify({ error: { message: "upstream model overloaded" } }),
    isRetryable: true,
  })

  const parsed = ProviderError.parseAPICallError({
    providerID: ProviderV2.ID.make("openai"),
    error,
  })

  expect(parsed.message).toContain("upstream model overloaded")
})
