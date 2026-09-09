import { describe, expect, it } from "vitest";
import { formatMissingScopeMessage } from "./missing-scope-message.js";

describe("formatMissingScopeMessage", () => {
  it("keeps the machine-readable prefix that log scrapers and failover matchers key off", () => {
    for (const message of [
      formatMissingScopeMessage({ missingScope: "operator.write", method: "tools.invoke" }),
      formatMissingScopeMessage({
        missingScope: "operator.write",
        method: "tools.invoke",
        presentedScopes: [],
      }),
      formatMissingScopeMessage({ missingScope: undefined }),
    ]) {
      expect(message).toMatch(/^missing scope: [a-z0-9._-]+/i);
    }
  });

  it("explains an empty scope set as an unbound connection rather than a role problem", () => {
    const message = formatMissingScopeMessage({
      missingScope: "operator.write",
      method: "tools.invoke",
      presentedScopes: [],
    });
    expect(message).toContain("presented no operator scopes at all");
    expect(message).toContain("paired device");
    expect(message).toContain("this happens to admins too");
  });

  it("names what the connection actually has when it is merely under-scoped", () => {
    const message = formatMissingScopeMessage({
      missingScope: "operator.write",
      method: "tools.invoke",
      presentedScopes: ["operator.read"],
    });
    expect(message).toContain('"tools.invoke" requires operator.write');
    expect(message).toContain("this connection has operator.read");
    expect(message).not.toContain("no operator scopes");
  });

  it("notes that write satisfies a read requirement", () => {
    const message = formatMissingScopeMessage({
      missingScope: "operator.read",
      method: "chat.history",
      presentedScopes: ["operator.pairing"],
    });
    expect(message).toContain("operator.read (or operator.write, which includes it)");
  });

  it("does not claim an admin requirement for a method that has no scope policy", () => {
    const message = formatMissingScopeMessage({
      missingScope: "operator.admin",
      method: "typo.method",
      presentedScopes: ["operator.write"],
      unclassifiedMethod: true,
    });
    expect(message).toContain("no registered scope policy");
    expect(message).toContain("denied by default rather than actually requiring operator.admin");
    expect(message).not.toContain("Approve operator.admin");
  });

  it("describes a non-method trigger through attemptedAction", () => {
    const message = formatMissingScopeMessage({
      missingScope: "operator.admin",
      attemptedAction: 'the "x-openclaw-model" model override header',
    });
    expect(message).toBe(
      'missing scope: operator.admin — the "x-openclaw-model" model override header requires operator.admin.',
    );
  });

  it("reports an unresolved scope as a gateway bug instead of printing undefined", () => {
    const message = formatMissingScopeMessage({ missingScope: undefined, method: "some.method" });
    expect(message).not.toContain("undefined");
    expect(message).toContain("no required scope could be resolved");
  });
});
