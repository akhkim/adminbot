import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ErrorResponse } from "@adminbot/api-contracts";
import {
  createRegistrationRoutes,
  type RegistrationApplication,
} from "./registration-routes.js";
import {
  createRegistrationReviewRoutes,
  type RegistrationReviewApplication,
  type SessionAuthenticator,
} from "./registration-review-routes.js";
import type { ApiResponse, ApiRouteHandler } from "./route-handler.js";
import { readSessionCookie } from "./session-cookie.js";
import {
  createSessionRoutes,
  type SessionApplication,
} from "./session-routes.js";
import { createPaperRoutes, type PaperApplication } from "./paper-routes.js";

const MAXIMUM_JSON_BODY_BYTES = 64 * 1_024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export interface ApiServerOptions {
  readonly registration: RegistrationApplication;
  readonly registrationReview: RegistrationReviewApplication;
  readonly sessions: SessionApplication & SessionAuthenticator;
  readonly papers?: PaperApplication;
  readonly allowedOrigins?: readonly string[];
  readonly secureCookies?: boolean;
  readonly onUnexpectedError?: (error: unknown, operationId?: string) => void;
}

export interface ListenOptions {
  readonly host?: "127.0.0.1" | "::1";
  readonly port: number;
}

export interface ListeningApiServer {
  readonly origin: string;
  close(): Promise<void>;
}

export class AdminBotApiServer {
  private readonly server: Server;

  constructor(options: ApiServerOptions) {
    const routes = [
      ...createRegistrationRoutes(options.registration),
      ...createSessionRoutes(options.sessions, { secure: options.secureCookies ?? false }),
      ...createRegistrationReviewRoutes(options.sessions, options.registrationReview),
      ...(options.papers === undefined ? [] : createPaperRoutes(options.sessions, options.papers)),
    ];
    const allowedOrigins = parseAllowedOrigins(options.allowedOrigins ?? []);
    this.server = createServer((request, response) => {
      void dispatchRequest(request, response, routes, allowedOrigins).catch((error: unknown) => {
        options.onUnexpectedError?.(error);
        if (!response.headersSent) {
          sendJson(response, { status: 500, body: apiError("internal_error", "request failed") });
        } else {
          response.destroy();
        }
      });
    });
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 30_000;
    this.server.keepAliveTimeout = 5_000;
  }

  listen(options: ListenOptions): Promise<ListeningApiServer> {
    const host = options.host ?? "127.0.0.1";
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error("AdminBot API currently refuses non-loopback bind addresses");
    }
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new Error("port must be an integer between 0 and 65535");
    }
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(options.port, host, () => {
        this.server.off("error", onError);
        const address = this.server.address() as AddressInfo;
        const originHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
        resolve({
          origin: `http://${originHost}:${address.port}`,
          close: () => closeServer(this.server),
        });
      });
    });
  }
}

async function dispatchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  routes: readonly ApiRouteHandler[],
  allowedOrigins: ReadonlySet<string>,
): Promise<void> {
  const origin = request.headers.origin;
  if (origin !== undefined && !allowedOrigins.has(origin)) {
    sendJson(response, {
      status: 403,
      body: apiError("not_authorized", "browser origin is not allowed"),
    });
    return;
  }

  const requestUrl = parseRequestUrl(request);
  const pathname = requestUrl.pathname;
  if (request.method === "OPTIONS") {
    handlePreflight(request, response, pathname, routes, origin);
    return;
  }
  const route = routes.find(
    (candidate) =>
      candidate.route.method === request.method && candidate.route.matches(pathname),
  );
  if (route === undefined) {
    const methods = routes
      .filter((candidate) => candidate.route.matches(pathname))
      .map((candidate) => candidate.route.method);
    sendJson(response, {
      status: methods.length === 0 ? 404 : 405,
      body: apiError(
        methods.length === 0 ? "not_found" : "payload_invalid",
        methods.length === 0 ? "route not found" : "method not allowed",
      ),
      ...(methods.length === 0 ? {} : { headers: { allow: methods.join(", ") } }),
    }, origin);
    return;
  }

  let body: unknown;
  if (route.body === "json") {
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      sendJson(response, {
        status: 415,
        body: apiError("payload_invalid", "content type must be application/json"),
      }, origin);
      return;
    }
    try {
      body = await readJsonBody(request);
    } catch (error) {
      if (!(error instanceof RequestBodyError)) throw error;
      sendJson(response, {
        status: error.status,
        body: apiError("payload_invalid", error.message),
      }, origin);
      return;
    }
  }

  const sessionToken = readSessionCookie(request.headers.cookie);
  const result = await route.handle({
    ...(body === undefined ? {} : { body }),
    pathname,
    query: requestUrl.searchParams,
    ...(request.socket.remoteAddress === undefined
      ? {}
      : { remoteAddress: request.socket.remoteAddress }),
    ...(sessionToken === undefined ? {} : { sessionToken }),
  });
  sendJson(response, result, origin);
}

function handlePreflight(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  routes: readonly ApiRouteHandler[],
  origin: string | undefined,
): void {
  const requestedMethod = request.headers["access-control-request-method"];
  const route = routes.find(
    (candidate) =>
      candidate.route.method === requestedMethod && candidate.route.matches(pathname),
  );
  if (origin === undefined || route === undefined) {
    sendJson(response, { status: 404, body: apiError("not_found", "route not found") });
    return;
  }
  response.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": route.route.method,
    "access-control-allow-headers": "content-type",
    "access-control-allow-credentials": "true",
    "access-control-max-age": "600",
    vary: "Origin",
  });
  response.end();
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > MAXIMUM_JSON_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(chunk);
    }
  }
  if (tooLarge) throw new RequestBodyError(413, "request body is too large");
  if (size === 0) throw new RequestBodyError(400, "request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestBodyError(400, "request body is not valid JSON");
  }
}

function parseRequestUrl(request: IncomingMessage): URL {
  if (request.url === undefined || request.url.length > 8_192) {
    return new URL("http://adminbot.invalid/invalid-request-target");
  }
  try {
    return new URL(request.url, "http://adminbot.invalid");
  } catch {
    return new URL("http://adminbot.invalid/invalid-request-target");
  }
}

function sendJson(response: ServerResponse, result: ApiResponse, origin?: string): void {
  const serialized = result.body === undefined ? undefined : JSON.stringify(result.body);
  response.writeHead(result.status, {
    ...(serialized === undefined
      ? {}
      : {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(Buffer.byteLength(serialized)),
        }),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    ...(origin === undefined
      ? {}
      : {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          vary: "Origin",
        }),
    ...result.headers,
  });
  response.end(serialized);
}

function apiError(code: ErrorResponse["code"], message: string): ErrorResponse {
  return { code, message, retryable: false };
}

function parseAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
  const parsed = new Set<string>();
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== "http:" && url.protocol !== "https:")) {
      throw new Error(`invalid allowed browser origin: ${origin}`);
    }
    parsed.add(origin);
  }
  return parsed;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
    this.name = "RequestBodyError";
  }
}
