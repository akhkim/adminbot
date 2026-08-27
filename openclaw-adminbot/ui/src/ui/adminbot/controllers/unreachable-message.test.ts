// Which failure gets which sentence.
//
// Two very different things could go wrong and both said the same thing: "AdminBot tools are not
// available in this Gateway. Enable the adminbot plugin..." That is true of a gateway missing its
// tool plugin. It is not true of a request to the AdminBot service that never landed -- and every
// HTTP loader on this page reported it for exactly that, so a workshop-nudge preview whose request
// timed out sent an admin off to enable a plugin that was already enabled.
//
// The workshop matcher is the likeliest thing here to trip it: it runs LLM calls across every open
// workshop, so it is the one request slow enough to be cut off.
import { describe, expect, it } from "vitest";
import {
  ADMINBOT_SERVICE_UNREACHABLE_MESSAGE,
  ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE,
} from "./admin.ts";

describe("the two failure messages", () => {
  it("keeps the gateway one about the gateway", () => {
    expect(ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE).toContain("Gateway");
    expect(ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE).toContain("adminbot plugin");
  });

  it("says what an unreachable service actually means, and points at the fix", () => {
    expect(ADMINBOT_SERVICE_UNREACHABLE_MESSAGE).toContain("reach the AdminBot service");
    // The three things worth checking, in the order somebody would check them.
    expect(ADMINBOT_SERVICE_UNREACHABLE_MESSAGE).toContain("running");
    expect(ADMINBOT_SERVICE_UNREACHABLE_MESSAGE).toContain("URL in Settings");
    expect(ADMINBOT_SERVICE_UNREACHABLE_MESSAGE).toContain("time to finish");
  });

  it("never blames the gateway plugin for a failed request", () => {
    expect(ADMINBOT_SERVICE_UNREACHABLE_MESSAGE).not.toContain("plugin");
    expect(ADMINBOT_SERVICE_UNREACHABLE_MESSAGE).not.toContain("Gateway");
    expect(ADMINBOT_SERVICE_UNREACHABLE_MESSAGE).not.toBe(ADMINBOT_TOOLS_UNAVAILABLE_MESSAGE);
  });
});
