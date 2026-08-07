#!/usr/bin/env node
// Post-build patch for the Vercel deploy of the Control UI.
//
// `pnpm ui:build` emits a generic dist/control-ui/index.html that knows nothing
// about where it will be hosted. The Vercel deploy needs two things injected that
// a plain build always loses:
//
//   1. <base href="/" />  — Vite emits relative ./assets/... tags (base: './'), so
//      once vercel.json's SPA rewrite serves index.html for a deep path like
//      /adminbot/announcements, the browser would resolve ./assets against that
//      path and 404 the whole bundle. Pinning <base> to root fixes resolution
//      regardless of the visited path.
//   2. A boot <script> that declares the aurora tailscale gateway as this page's
//      default and seeds adminBotUrl. The gateway goes in a global rather than a
//      ?gatewayUrl= param on purpose: a param reads as "someone is changing your
//      gateway" and the UI (rightly) makes the visitor confirm that, which meant a
//      first visit dialled a dead default, failed, and then demanded a click. As a
//      declared default it is simply what this deployment connects to. The legacy
//      hosts are still rewritten out of any param a stale bookmark carries.
//
// This script is invoked from vercel.json's buildCommand after ui:build. It is
// idempotent: running it on already-injected HTML is a no-op. Keep the aurora
// hostnames here in sync with the deploy target.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(repoRoot, "dist", "control-ui", "index.html");

const BASE_TAG = '    <base href="/" />';

const GATEWAY_SCRIPT = `    <script>
      (function () {
        var DEFAULT_GATEWAY_URL = "wss://aurora-adminbot.taila4f725.ts.net";
        var DEFAULT_ADMINBOT_URL = "https://aurora-adminbot.taila4f725.ts.net:8443";
        var LEGACY_GATEWAY_URLS = [
          "wss://desktop-k2ba38v-1.taila4f725.ts.net",
          "wss://andrew.taila4f725.ts.net",
        ];
        window.__OPENCLAW_CONTROL_UI_GATEWAY_URL__ = DEFAULT_GATEWAY_URL;
        try {
          var url = new URL(window.location.href);
          var changed = false;
          var configuredGateway = url.searchParams.get("gatewayUrl");
          // A stale bookmark pinning a retired gateway host would otherwise keep prompting to
          // switch to a host that no longer exists; drop it and let the declared default stand.
          if (configuredGateway && LEGACY_GATEWAY_URLS.includes(configuredGateway)) {
            url.searchParams.delete("gatewayUrl");
            changed = true;
          }
          if (!url.searchParams.get("adminBotUrl")) {
            url.searchParams.set("adminBotUrl", DEFAULT_ADMINBOT_URL);
            changed = true;
          }
          if (changed) {
            window.history.replaceState(null, "", url);
          }
        } catch (e) {}
      })();
    </script>
`;

async function main() {
  let html;
  try {
    html = await readFile(indexPath, "utf8");
  } catch (err) {
    console.error(`[vercel-postbuild] cannot read ${indexPath}: ${err.message}`);
    console.error("[vercel-postbuild] run `pnpm ui:build` first.");
    process.exit(1);
  }

  let changed = false;

  // 1. <base href="/"> — insert right after the color-scheme meta if absent.
  if (!/<base\s/i.test(html)) {
    const marker = /(<meta\s+name=["']color-scheme["'][^>]*>\s*\n)/i;
    if (!marker.test(html)) {
      console.error('[vercel-postbuild] could not find <meta name="color-scheme"> anchor for <base>.');
      process.exit(1);
    }
    html = html.replace(marker, `$1${BASE_TAG}\n`);
    changed = true;
    console.log("[vercel-postbuild] injected <base href=\"/\">");
  } else {
    console.log("[vercel-postbuild] <base> already present — skipping");
  }

  // 2. Gateway-URL forcing script — insert before </head> if absent.
  if (!html.includes("DEFAULT_GATEWAY_URL")) {
    const headClose = /(\n?)([ \t]*<\/head>)/i;
    if (!headClose.test(html)) {
      console.error("[vercel-postbuild] could not find </head> to inject the gateway script.");
      process.exit(1);
    }
    html = html.replace(headClose, `\n${GATEWAY_SCRIPT}$2`);
    changed = true;
    console.log("[vercel-postbuild] injected gateway-URL boot script");
  } else {
    console.log("[vercel-postbuild] gateway boot script already present — skipping");
  }

  if (changed) {
    await writeFile(indexPath, html, "utf8");
    console.log(`[vercel-postbuild] wrote ${indexPath}`);
  } else {
    console.log("[vercel-postbuild] nothing to do");
  }
}

main().catch((err) => {
  console.error(`[vercel-postbuild] ${err.stack || err}`);
  process.exit(1);
});
