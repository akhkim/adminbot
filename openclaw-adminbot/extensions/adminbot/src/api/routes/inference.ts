// The shared GPU's admission gate: queue state, the caller's own rows, preferences and the
// operator controls (see server.inference.ts).
import { sendJson } from "../server.http.js";
import { handleInferenceRoute } from "../server.inference.js";
import { isPrivileged, principalActor } from "./guards.js";
import { route, type Route, under } from "./router.js";

export const inferenceRoutes: readonly Route[] = [
  route("*", under("/inference"), async ({ req, res, url, ctx, principal }) => {
    // The owner is the session, never the URL or the body. The service principal owns the rows it
    // submitted (as "service"); anonymous callers are denied by the boundary above this function.
    const handled = await handleInferenceRoute(
      req,
      res,
      url,
      ctx.inferenceGate,
      principalActor(principal),
      isPrivileged(principal),
      {
        pause: () => ctx.taskRuntime.pause(),
        resume: () => ctx.taskRuntime.resume(),
        metrics: () => ctx.taskRuntime.metrics(),
      },
    );
    if (!handled) {
      sendJson(res, 404, { error: { message: "not found" } });
    }
  }),
];
