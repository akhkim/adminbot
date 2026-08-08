import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apiErrorCodes } from "./errors.js";
import { API_BASE_PATH, apiRoutes, createApiUrl } from "./routes.js";

interface OpenApiOperation {
  readonly operationId?: string;
}

interface OpenApiDocument {
  readonly components: {
    readonly schemas: Readonly<
      Record<string, { readonly enum?: readonly string[] } | undefined>
    >;
  };
  readonly paths: Readonly<
    Record<string, Readonly<Record<string, OpenApiOperation | undefined>> | undefined>
  >;
}

describe("versioned API routes", () => {
  it("uses one explicit v0alpha base path", () => {
    expect(API_BASE_PATH).toBe("/v0alpha");
    expect(apiRoutes.submitSignup.build()).toBe(
      "/v0alpha/auth/registrations/signups",
    );
    expect(createApiUrl("http://127.0.0.1:8765", apiRoutes.submitSignup.build()).href).toBe(
      "http://127.0.0.1:8765/v0alpha/auth/registrations/signups",
    );
  });

  it("encodes and matches registration ids through the same route", () => {
    const pathname = apiRoutes.decideRegistration.build({ registrationId: "request/a b" });
    expect(pathname).toBe(
      "/v0alpha/auth/registrations/request%2Fa%20b/decision",
    );
    expect(apiRoutes.decideRegistration.match(pathname)).toEqual({
      registrationId: "request/a b",
    });
    expect(apiRoutes.decideRegistration.match("/auth/registrations/x/decision")).toBeUndefined();
  });

  it("is exactly aligned with generated TypeSpec operations", () => {
    const document = readGeneratedOpenApi();
    for (const route of Object.values(apiRoutes)) {
      const operation = document.paths[route.template]?.[route.method.toLowerCase()];
      expect(operation?.operationId, `${route.method} ${route.template}`).toBe(
        route.operationId,
      );
    }
  });

  it("keeps runtime error-code guards aligned with TypeSpec", () => {
    const schema = readGeneratedOpenApi().components.schemas[
      "AdminBot.Contracts.Common.ErrorCode"
    ];
    expect(schema?.enum).toEqual(apiErrorCodes);
  });
});

function readGeneratedOpenApi(): OpenApiDocument {
  const path = fileURLToPath(
    new URL("../../../.generated/openapi/openapi.json", import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as OpenApiDocument;
}
