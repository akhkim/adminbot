// The generated HTTP contract, for clients that discover operations at runtime.
//
// Behind authentication on purpose: it lists every route, admin-only ones included, and the
// service is reachable from the internet through the tunnel. The CLI ships its own copy and never
// needs this to start.
import document from "../../../cli/openapi.generated.json" with { type: "json" };
import { get, type Route } from "./router.js";

// Not sendJson: that drops keys named like private member fields, and a schema property called
// `password` is the contract describing the field, not a member's password. Serialized once.
const body = JSON.stringify(document);

export const openapiRoutes: readonly Route[] = [
  get("/openapi.json", ({ res }) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  }),
];
