import { describe, expect, it } from "vitest";
import { APP_ROUTES, appRoute, resolveAppRoute, routesInGroup } from "./app-routes.js";

describe("AdminBot application routes", () => {
  it("keeps every path and route identifier unique", () => {
    expect(new Set(APP_ROUTES.map(({ id }) => id)).size).toBe(APP_ROUTES.length);
    expect(new Set(APP_ROUTES.map(({ path }) => path)).size).toBe(APP_ROUTES.length);
  });

  it("resolves canonical paths, legacy overview alias, and unknown paths", () => {
    expect(resolveAppRoute("/adminbot/members/").id).toBe("members");
    expect(resolveAppRoute("/adminbot").id).toBe("overview");
    expect(resolveAppRoute("/not-a-real-page").id).toBe("overview");
  });

  it("keeps administrator routes out of public and member navigation groups", () => {
    expect(routesInGroup("public").every(({ audience }) => audience === "public")).toBe(true);
    expect(routesInGroup("workspace").every(({ audience }) => audience === "member")).toBe(true);
    expect(routesInGroup("operations").every(({ audience }) => audience === "administrator")).toBe(
      true,
    );
    expect(appRoute("access").status).toBe("live");
  });
});
