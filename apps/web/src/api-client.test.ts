import { apiRoutes, type SignupRegistrationInput } from "@adminbot/api-contracts";
import { describe, expect, it, vi } from "vitest";
import { RegistrationApiClient, RegistrationApiError } from "./api-client.js";

describe("RegistrationApiClient", () => {
  it("uses the centralized versioned route with generated request types", async () => {
    const requests: Array<readonly [URL | RequestInfo, RequestInit | undefined]> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push([input, init]);
      return jsonResponse(202, {
        registrationId: "30000000-0000-4000-8000-000000000001",
        state: "submitted",
      });
    };
    const client = new RegistrationApiClient({
      serviceOrigin: "https://adminbot.example",
      fetch,
    });
    const input: SignupRegistrationInput = {
      email: "applicant@example.com",
      password: "correct horse battery staple",
      profile: { displayName: "Synthetic Applicant" },
    };

    await expect(client.submitSignup(input)).resolves.toMatchObject({ state: "submitted" });
    const [url, init] = requests[0] ?? [];
    expect(String(url)).toBe(
      `https://adminbot.example${apiRoutes.submitSignup.build()}`,
    );
    expect(init).toMatchObject({
      method: apiRoutes.submitSignup.method,
      credentials: "include",
      body: JSON.stringify(input),
    });
  });

  it("preserves stable API errors and retry guidance", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        429,
        {
          code: "rate_limited",
          message: "too many registration attempts; try again later",
          retryable: true,
        },
        { "retry-after": "120" },
      ),
    );
    const client = new RegistrationApiClient({
      serviceOrigin: "https://adminbot.example",
      fetch: fetch as typeof globalThis.fetch,
    });

    const error = await client
      .submitClaim({
        personId: "20000000-0000-4000-8000-000000000001",
        email: "member@example.com",
        password: "correct horse battery staple",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistrationApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 120,
    });
  });

  it("fails closed on a malformed success response", async () => {
    const client = new RegistrationApiClient({
      serviceOrigin: "https://adminbot.example",
      fetch: vi.fn(async () => jsonResponse(202, { state: "approved" })) as typeof fetch,
    });

    await expect(
      client.submitSignup({
        email: "applicant@example.com",
        password: "correct horse battery staple",
        profile: { displayName: "Synthetic Applicant" },
      }),
    ).rejects.toMatchObject({ status: 502, code: "dependency_unavailable" });
  });
});

function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
