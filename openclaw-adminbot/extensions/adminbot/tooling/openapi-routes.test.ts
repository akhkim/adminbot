import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { buildOpenApi } from "./generate-openapi.js";
import { regexPaths } from "./openapi-routes.js";

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "adminbot-openapi-"));
  mkdirSync(join(root, "src/api/routes"), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(root, "src/api", name), source);
  }
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

// The route table's helpers, as routes/router.ts declares them.
const ROUTER = `
  export type RouteRequest = { req: { method: string }; res: unknown; url: URL; params: readonly string[] };
  export type RouteHandler = (request: RouteRequest) => unknown;
  export type Route = { handle: RouteHandler };
  type PathMatcher = (pathname: string) => readonly string[] | null;
  export function route(methods: readonly string[] | "*", path: string | RegExp | PathMatcher, handle: RouteHandler): Route { return { handle }; }
  export const get = (path: string | RegExp | PathMatcher, handle: RouteHandler) => route(["GET"], path, handle);
  export const put = (path: string | RegExp | PathMatcher, handle: RouteHandler) => route(["PUT"], path, handle);
  export const patch = (path: string | RegExp | PathMatcher, handle: RouteHandler) => route(["PATCH"], path, handle);
  export function startingWith(base: string): PathMatcher { return (p) => (p.startsWith(base) ? [p] : null); }
`;

test("generation follows new handlers and TypeScript fields without a route/schema table", () => {
  const source = `
    declare const req: {method: string}; declare const url: URL; declare const res: unknown;
    declare function readJson(req: unknown): Promise<unknown>;
    declare function sendJson(res: unknown, status: number, body: unknown): void;
    type Progress = {current_step: 'writing' | 'submitted'; done?: boolean};
    async function handleAuthenticatedRoute() {
      const paper = /^\\/papers\\/([^/]+)\\/progress$/u.exec(url.pathname);
      if (req.method === 'PATCH' && paper?.[1]) {
        const body = await readJson(req) as Progress;
        sendJson(res, 200, {saved: body.current_step}); return;
      }
    }`;
  const example = fixture({ "server.ts": source });
  try {
    const first = buildOpenApi(example.root);
    const operation = first.paths["/papers/{papers_id}/progress"].patch as {
      requestBody: {
        content: {
          "application/json": { schema: { properties: { current_step: { enum: string[] } } } };
        };
      };
    };
    assert.deepEqual(
      operation.requestBody.content["application/json"].schema.properties.current_step.enum,
      ["writing", "submitted"],
    );
    assert.deepEqual(buildOpenApi(example.root), first);
    writeFileSync(
      join(example.root, "src/api/server.ts"),
      source.replace("'submitted'", "'submitted' | 'accepted'").replace("/progress$", "/stage$"),
    );
    const updated = buildOpenApi(example.root);
    assert.ok(updated.paths["/papers/{papers_id}/stage"]);
  } finally {
    example.close();
  }
});

// The point of dropping line numbers and the source hash: a PR that touches the API's files
// without changing the API must not have to regenerate, or conflict with one that did.
test("an edit that does not change the API leaves the contract byte-identical", () => {
  const handler = `
    declare const req: {method: string}; declare const url: URL;
    function handleAuthenticatedRoute() {
      if (req.method === 'GET' && url.pathname === '/things') { return; }
    }`;
  const example = fixture({ "server.ts": handler });
  try {
    const first = JSON.stringify(buildOpenApi(example.root));
    writeFileSync(
      join(example.root, "src/api/server.ts"),
      `// A comment, a blank line and a moved function.\n\n${handler}\nfunction unrelated() {}\n`,
    );
    assert.equal(JSON.stringify(buildOpenApi(example.root)), first);
  } finally {
    example.close();
  }
});

test("optional suffixes keep GET/POST guards instead of inventing route combinations", () => {
  const example = fixture({
    "server.ts": `
    declare const req: {method: string}; declare const url: URL;
    function handleAuthenticatedRoute() {
      const request = /^\\/requests\\/([^/]+)(\\/close)?$/u.exec(url.pathname);
      if (request && ((req.method === 'PUT' && !request[2]) || (req.method === 'POST' && request[2]))) { return; }
    }`,
  });
  try {
    const paths = buildOpenApi(example.root).paths;
    assert.deepEqual(Object.keys(paths["/requests/{requests_id}"]), ["put"]);
    assert.deepEqual(Object.keys(paths["/requests/{requests_id}/close"]), ["post"]);
  } finally {
    example.close();
  }
});

test("reads the route table: fixed entries, '*' entries and prefix sub-routers", () => {
  const example = fixture({
    "routes/router.ts": ROUTER,
    "server.drafts.ts": `
      declare function sendJson(res: unknown, status: number, body: unknown): void;
      export function handleDraft(req: { method: string }, res: unknown, key: string) {
        if (req.method === "GET") { sendJson(res, 200, { key }); return; }
        if (req.method !== "PUT") { sendJson(res, 405, {}); return; }
        sendJson(res, 200, { saved: key });
      }`,
    "routes/things.ts": `
      import { get, patch, put, route, startingWith, type Route, type RouteHandler } from "./router.js";
      import { handleDraft } from "../server.drafts.js";
      const guarded = (handler: RouteHandler): RouteHandler => handler;
      const named: RouteHandler = () => undefined;
      export const thingRoutes: readonly Route[] = [
        get("/things", () => undefined),
        put(/^\\/things\\/([^/]+)$/u, guarded(() => undefined)),
        patch(/^\\/things\\/([^/]+)\\/(open|close)$/u, guarded(named)),
        route("*", "/inbox", ({ req }) => { if (req.method === "GET") { return; } }),
        route("*", startingWith("/drafts/"), ({ req, res, url }) => handleDraft(req, res, url.pathname)),
      ];`,
  });
  try {
    const paths = buildOpenApi(example.root).paths;
    assert.deepEqual(Object.keys(paths["/things"]), ["get"]);
    assert.deepEqual(Object.keys(paths["/things/{things_id}"]), ["put"]);
    assert.deepEqual(Object.keys(paths["/things/{things_id}/open"]), ["patch"]);
    assert.deepEqual(Object.keys(paths["/things/{things_id}/close"]), ["patch"]);
    assert.deepEqual(Object.keys(paths["/inbox"]), ["get"]);
    // The sub-router only selects a method; the table entry supplies the path.
    assert.deepEqual(Object.keys(paths["/drafts/{drafts_id}"]).toSorted(), ["get", "put"]);
    // Table routes are authenticated: they inherit the document's bearer requirement.
    assert.equal((paths["/things"].get as { security?: unknown }).security, undefined);
  } finally {
    example.close();
  }
});

test("adjacent captures take their names from the handler's call", () => {
  const example = fixture({
    "routes/router.ts": ROUTER,
    "routes/badges.ts": `
      import { put, type Route } from "./router.js";
      declare function removeBadge(memberId: string, badgeId: string): void;
      export const badgeRoutes: readonly Route[] = [
        put(/^\\/badges\\/assignments\\/([^/]+)\\/([^/]+)$/u, ({ params }) =>
          removeBadge(decodeURIComponent(params[1]!), decodeURIComponent(params[2]!)),
        ),
      ];`,
  });
  try {
    const paths = buildOpenApi(example.root).paths;
    const operation = paths["/badges/assignments/{member_id}/{badge_id}"].put as {
      operationId: string;
    };
    assert.equal(operation.operationId, "put-badges-assignments-by-member-id-by-badge-id");
  } finally {
    example.close();
  }
  assert.throws(
    () => regexPaths("/^\\/pairs\\/([^/]+)\\/([^/]+)$/u"),
    /Cannot name capture 1 of adjacent captures/u,
  );
});

// Routes that hand url.searchParams to a reader or a service method must still list the query
// it reads; otherwise the CLI has no flag for it (who's-in had no --place, lists no --cursor).
test("query names read by a helper or service method that receives url.searchParams", () => {
  const example = fixture({
    "routes/router.ts": ROUTER,
    "routes/trips.ts": `
      import { get, type Route } from "./router.js";
      function readPage(params: URLSearchParams) { return { limit: params.get("limit"), cursor: params.get("cursor") }; }
      class Travel {
        whosIn(memberId: string, query: URLSearchParams) { return [memberId, query.get("place"), query.has("from")]; }
      }
      declare const travel: Travel;
      export const tripRoutes: readonly Route[] = [
        get("/trips", ({ url }) => readPage(url.searchParams)),
        get("/whos-in", ({ url }) => { const params = url.searchParams; return travel.whosIn("me", params); }),
      ];`,
  });
  try {
    const paths = buildOpenApi(example.root).paths;
    const names = (path: string) =>
      ((paths[path].get as { parameters: { name: string; in: string }[] }).parameters ?? [])
        .filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name);
    assert.deepEqual(names("/trips"), ["cursor", "limit"]);
    assert.deepEqual(names("/whos-in"), ["from", "place"]);
  } finally {
    example.close();
  }
});

test("unrecognized route selectors fail generation rather than silently losing coverage", () => {
  assert.throws(() => regexPaths("/^\\/items\\/(\\d+)$/u"), /Unsupported route regex/u);
  const example = fixture({
    "server.ts": `declare const req: {method: string}; declare const url: URL; function routeRequest() { if (req.method === 'GET' && url.pathname.endsWith('/future')) { return; } }`,
  });
  try {
    assert.throws(() => buildOpenApi(example.root), /Uncovered route selector/u);
  } finally {
    example.close();
  }
});

test("a table entry whose path the generator cannot read fails generation", () => {
  const example = fixture({
    "routes/router.ts": ROUTER,
    "routes/odd.ts": `
      import { get, type Route } from "./router.js";
      const computed = (p: string) => [p];
      export const oddRoutes: readonly Route[] = [get(computed, () => undefined)];`,
  });
  try {
    assert.throws(() => buildOpenApi(example.root), /Unsupported route path/u);
  } finally {
    example.close();
  }
});
