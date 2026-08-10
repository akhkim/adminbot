import { describe, expect, it } from "vitest";
import { resolveAdvertisedGatewayUrl } from "./advertised-gateway-url.ts";

const HOSTED_PAGE = "https://jinesis-admin.vercel.app/chat";
const REMOTE_GATEWAY = "wss://adminbot.tailnet.example.ts.net";

describe("resolveAdvertisedGatewayUrl", () => {
  // The regression: AdminBot advertised its own loopback address, sign-in adopted it, and the
  // browser then dialled port 18789 on the member's own laptop and got a refused socket (1006).
  it("keeps the page's gateway URL when a remote service advertises loopback", () => {
    expect(
      resolveAdvertisedGatewayUrl({
        advertised: "ws://127.0.0.1:18789",
        current: REMOTE_GATEWAY,
        pageHref: HOSTED_PAGE,
      }),
    ).toBe(REMOTE_GATEWAY);
  });

  it.each(["ws://localhost:18789", "ws://127.0.0.2:18789", "ws://[::1]:18789"])(
    "treats %s as unreachable loopback from a hosted page",
    (advertised) => {
      expect(
        resolveAdvertisedGatewayUrl({ advertised, current: REMOTE_GATEWAY, pageHref: HOSTED_PAGE }),
      ).toBe(REMOTE_GATEWAY);
    },
  );

  // The local `openclaw dashboard` case: the UI is served by the gateway itself, so the loopback
  // address it advertises is exactly right and must still be honoured.
  it("adopts loopback when the page is itself on loopback", () => {
    expect(
      resolveAdvertisedGatewayUrl({
        advertised: "ws://127.0.0.1:18789",
        current: "ws://127.0.0.1:18789",
        pageHref: "http://127.0.0.1:18789/chat",
      }),
    ).toBe("ws://127.0.0.1:18789");
  });

  it("adopts a routable advertised URL", () => {
    expect(
      resolveAdvertisedGatewayUrl({
        advertised: "wss://gateway.example.ts.net",
        current: REMOTE_GATEWAY,
        pageHref: HOSTED_PAGE,
      }),
    ).toBe("wss://gateway.example.ts.net");
  });

  // An older service that emitted `url: ""` must not win over the configured URL either — an empty
  // string is not nullish, so `??` alone let it through.
  it.each([undefined, "", "   ", "not a url", "https://adminbot.tailnet.example.ts.net"])(
    "keeps the current URL when the advertised value is %p (unusable as a gateway URL)",
    (advertised) => {
      expect(
        resolveAdvertisedGatewayUrl({ advertised, current: REMOTE_GATEWAY, pageHref: HOSTED_PAGE }),
      ).toBe(REMOTE_GATEWAY);
    },
  );
});
