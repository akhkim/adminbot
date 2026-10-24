// The generated HTTP contract, for clients that discover operations at runtime.
//
// Behind authentication on purpose: it lists every route, admin-only ones included, and the
// service is reachable from the internet through the tunnel. The CLI ships its own copy and never
// needs this to start.
import document from "../../../cli/openapi.generated.json" with { type: "json" };
import { sendJson } from "../server.http.js";
import { get, type Route } from "./router.js";

export const openapiRoutes: readonly Route[] = [
  get("/openapi.json", ({ res }) => {
    sendJson(res, 200, document);
  }),
];
