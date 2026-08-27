#!/usr/bin/env node
// Post-build patch for the Vercel deploy of the Control UI.
//
// `pnpm ui:build` emits a generic dist/control-ui/index.html that knows nothing
// about where it will be hosted. The Vercel deploy needs three things that a plain
// build always loses:
//
//   1. <base href="/" />  — Vite emits relative ./assets/... tags (base: './'), so
//      once vercel.json's SPA rewrite serves index.html for a deep path like
//      /adminbot/announcements, the browser would resolve ./assets against that
//      path and 404 the whole bundle. Pinning <base> to root fixes resolution
//      regardless of the visited path.
//   2. A boot <script> that declares the tailnet gateway as this page's default
//      and seeds adminBotUrl. The gateway goes in a global rather than a
//      ?gatewayUrl= param on purpose: a param reads as "someone is changing your
//      gateway" and the UI (rightly) makes the visitor confirm that, which meant a
//      first visit dialled a dead default, failed, and then demanded a click. As a
//      declared default it is simply what this deployment connects to. The legacy
//      hosts are still rewritten out of any param a stale bookmark carries.
//   3. A route-specific /deadlines document. It keeps the same application
//      bundle and native Control UI, but its source also carries sanitized deadline
//      names and dates so crawlers do not receive only an empty custom-element shell.
//
// The tailnet is named by the environment, not by this file: ADMINBOT_TAILNET_DOMAIN
// is the MagicDNS domain and ADMINBOT_TAILNET_NODES is a comma list whose first entry
// is the live gateway node and whose remaining entries are retired hosts to scrub out
// of stale bookmarks. Unset, step 2 is skipped and the page ships without a declared
// gateway -- the visitor supplies one, which is what a build outside this deployment
// wants anyway.
//
// This script is invoked from vercel.json's buildCommand after ui:build. It is
// idempotent: running it on already-injected HTML is a no-op.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(repoRoot, "dist", "control-ui", "index.html");
const outputRoot = path.dirname(indexPath);
const deadlineDataPath = path.join(
  repoRoot,
  "extensions",
  "adminbot",
  "content",
  "deadlines",
  "venues.json",
);

const BASE_TAG = '    <base href="/" />';
const DEADLINES_ROUTE = "/deadlines";
export const DEADLINES_PUBLIC_URL = `https://jinesis-admin.vercel.app${DEADLINES_ROUTE}`;
export const DEADLINES_ROBOTS_TEXT = `User-agent: *
Disallow: /
Allow: ${DEADLINES_ROUTE}
Allow: /assets/
Allow: /favicon.svg
Allow: /favicon-32.png
Allow: /apple-touch-icon.png
Sitemap: https://jinesis-admin.vercel.app/sitemap.xml
`;
export const DEADLINES_SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${DEADLINES_PUBLIC_URL}</loc></url>
</urlset>
`;

const DEADLINES_META = `    <meta
      name="description"
      content="Past and upcoming conference &amp; workshop deadlines."
    />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${DEADLINES_PUBLIC_URL}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="Deadlines | Jinesis Lab" />
    <meta
      property="og:description"
      content="Past and upcoming conference &amp; workshop deadlines."
    />
    <meta property="og:url" content="${DEADLINES_PUBLIC_URL}" />`;

const DEADLINES_FALLBACK_STYLE = `    <style id="deadline-index-fallback-style">
      #deadline-index-fallback {
        padding: var(--space-8) var(--space-6);
      }
      #deadline-index-fallback .deadline-index-card {
        padding: var(--space-5);
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-xl);
        background: var(--card);
      }
      #deadline-index-fallback .deadline-index-list {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
        gap: var(--space-4) var(--space-6);
        margin: var(--space-5) 0 0;
        padding: 0;
        list-style: none;
      }
      #deadline-index-fallback .deadline-index-list h3 {
        margin: 0;
        color: var(--text-strong);
        font-size: var(--control-ui-text-sm);
      }
      #deadline-index-fallback .deadline-index-list p {
        margin: var(--space-1) 0 0;
        color: var(--muted);
        font-size: var(--control-ui-text-xs);
      }
    </style>`;

const DEADLINES_FALLBACK_CLEANUP = `    <script id="deadline-index-fallback-cleanup">
      (() => {
        const fallback = document.getElementById("deadline-index-fallback");
        const host = fallback?.parentElement;
        if (!fallback || !host) return;
        const observer = new MutationObserver(() => {
          if (Array.from(host.children).some((child) => child !== fallback)) {
            fallback.remove();
            document.getElementById("deadline-index-fallback-style")?.remove();
            observer.disconnect();
          }
        });
        observer.observe(host, { childList: true });
        document.currentScript?.remove();
      })();
    </script>`;

const ADMINBOT_TLS_PORT = 8443;

const stripTrailingSlashes = (value) => value.replace(/\/+$/, "");

const staticText = (item, key) => {
  const value = item[key];
  return typeof value === "string" ? value.trim() : "";
};

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

function staticLink(item) {
  for (const key of ["cfp_url", "homepage_url", "link", "openreview_url"]) {
    const candidate = staticText(item, key);
    if (!candidate) {
      continue;
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.href;
      }
    } catch {
      // Invalid and non-web source values remain unlinked text in the public projection.
    }
  }
  return undefined;
}

function staticDeadline(item) {
  const value = staticText(item, "deadline_aoe");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) {
    return "";
  }
  return `<time datetime="${value.replace(" ", "T")}-12:00">${escapeHtml(value.slice(0, 16))} AoE</time>`;
}

export function renderDeadlineIndexFallback(items) {
  const rows = items.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }
    const name = staticText(candidate, "name");
    if (!name) {
      return [];
    }
    const link = staticLink(candidate);
    const title = link
      ? `<a href="${escapeHtml(link)}" rel="noopener noreferrer">${escapeHtml(name)}</a>`
      : escapeHtml(name);
    const details = [
      escapeHtml(staticText(candidate, "venue_group")),
      escapeHtml(staticText(candidate, "deadline_label")),
      staticDeadline(candidate),
    ]
      .filter(Boolean)
      .join(" · ");
    return [`<li><article><h3>${title}</h3>${details ? `<p>${details}</p>` : ""}</article></li>`];
  });
  const content = rows.length
    ? `<ul class="deadline-index-list">${rows.join("")}</ul>`
    : "<p>No deadlines are currently published.</p>";
  return `<main id="deadline-index-fallback" class="deadline-board">
      <header class="deadline-board__header">
        <h1>Deadlines</h1>
        <p>Past and upcoming conference &amp; workshop deadlines.</p>
      </header>
      <section class="deadline-index-card" aria-labelledby="deadline-index-list-title">
        <h2 id="deadline-index-list-title">Tracked deadlines</h2>
        <p>Submission times are shown in Anywhere on Earth (UTC−12).</p>
        ${content}
      </section>
    </main>`;
}

export function renderDeadlineRouteHtml(appHtml, items) {
  const titlePattern = /<title>[^<]*<\/title>/i;
  const headPattern = /<\/head>/i;
  const appPattern = /<openclaw-app(?:\s[^>]*)?>\s*<\/openclaw-app>/i;
  if (!titlePattern.test(appHtml)) {
    throw new Error("Control UI index has no <title> anchor for deadline metadata");
  }
  if (!appPattern.test(appHtml)) {
    throw new Error("Control UI index has no empty <openclaw-app> shell for deadline content");
  }
  if (!headPattern.test(appHtml)) {
    throw new Error("Control UI index has no </head> anchor for deadline metadata");
  }
  const withTitle = appHtml.replace(titlePattern, "<title>Deadlines | Jinesis Lab</title>");
  const withHead = withTitle.replace(
    /(\n?)([ \t]*<\/head>)/i,
    `\n${DEADLINES_META}\n${DEADLINES_FALLBACK_STYLE}\n$2`,
  );
  return withHead.replace(
    appPattern,
    `<openclaw-app>\n${renderDeadlineIndexFallback(items)}\n    </openclaw-app>\n${DEADLINES_FALLBACK_CLEANUP}`,
  );
}

/**
 * The default gateway/AdminBot URLs this build declares, or undefined when none is configured.
 *
 * Two sources, in precedence order:
 *   - ADMINBOT_PUBLIC_URL / ADMINBOT_PUBLIC_GATEWAY_URL: explicit public origins (e.g. a Cloudflare
 *     tunnel fronting AdminBot). Either may be set independently; a public AdminBot URL alone is
 *     enough to fix member login, which only talks to the AdminBot service.
 *   - ADMINBOT_TAILNET_DOMAIN + ADMINBOT_TAILNET_NODES: a Tailscale tailnet whose first node fronts
 *     both services (gateway on wss, AdminBot on :8443).
 * The explicit public URLs win over the tailnet-derived ones for the same field.
 */
function resolveDefaults() {
  const domain = process.env.ADMINBOT_TAILNET_DOMAIN?.trim();
  const nodes = (process.env.ADMINBOT_TAILNET_NODES ?? "")
    .split(",")
    .map((node) => node.trim())
    .filter(Boolean);
  const tailnet =
    domain && nodes.length > 0 ? { domain, primary: nodes[0], legacy: nodes.slice(1) } : undefined;

  const publicAdminBot = process.env.ADMINBOT_PUBLIC_URL?.trim();
  const publicGateway = process.env.ADMINBOT_PUBLIC_GATEWAY_URL?.trim();

  const adminBotUrl = publicAdminBot
    ? stripTrailingSlashes(publicAdminBot)
    : tailnet
      ? `https://${tailnet.primary}.${tailnet.domain}:${ADMINBOT_TLS_PORT}`
      : undefined;
  const gatewayUrl = publicGateway
    ? stripTrailingSlashes(publicGateway)
    : tailnet
      ? `wss://${tailnet.primary}.${tailnet.domain}`
      : undefined;
  const legacyGatewayUrls = tailnet
    ? tailnet.legacy.map((node) => `wss://${node}.${tailnet.domain}`)
    : [];

  if (!adminBotUrl && !gatewayUrl) {
    return undefined;
  }
  return { gatewayUrl, adminBotUrl, legacyGatewayUrls };
}

const gatewayScript = (defaults) => `    <script>
      (function () {
        var DEFAULT_GATEWAY_URL = ${JSON.stringify(defaults.gatewayUrl ?? null)};
        var DEFAULT_ADMINBOT_URL = ${JSON.stringify(defaults.adminBotUrl ?? null)};
        var LEGACY_GATEWAY_URLS = ${JSON.stringify(defaults.legacyGatewayUrls)};
        if (DEFAULT_GATEWAY_URL) {
          window.__OPENCLAW_CONTROL_UI_GATEWAY_URL__ = DEFAULT_GATEWAY_URL;
        }
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
          if (DEFAULT_ADMINBOT_URL && !url.searchParams.get("adminBotUrl")) {
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
      console.error(
        '[vercel-postbuild] could not find <meta name="color-scheme"> anchor for <base>.',
      );
      process.exit(1);
    }
    html = html.replace(marker, `$1${BASE_TAG}\n`);
    changed = true;
    console.log('[vercel-postbuild] injected <base href="/">');
  } else {
    console.log("[vercel-postbuild] <base> already present — skipping");
  }

  // 2. Gateway-URL forcing script — insert before </head> if absent.
  const defaults = resolveDefaults();
  if (!defaults) {
    console.log(
      "[vercel-postbuild] no ADMINBOT_PUBLIC_URL or ADMINBOT_TAILNET_DOMAIN/NODES — emitting the page without a declared gateway",
    );
  } else if (!html.includes("DEFAULT_GATEWAY_URL")) {
    const headClose = /(\n?)([ \t]*<\/head>)/i;
    if (!headClose.test(html)) {
      console.error("[vercel-postbuild] could not find </head> to inject the gateway script.");
      process.exit(1);
    }
    html = html.replace(headClose, `\n${gatewayScript(defaults)}$2`);
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

  const deadlineData = JSON.parse(await readFile(deadlineDataPath, "utf8"));
  if (!Array.isArray(deadlineData.items)) {
    throw new Error(`${deadlineDataPath} has no deadline item array`);
  }
  // Derived from the route so the written file and the vercel.json rewrite cannot disagree:
  // a mismatch here serves the SPA shell to crawlers instead of the prerendered board.
  const deadlinesDir = path.join(outputRoot, ...DEADLINES_ROUTE.split("/").filter(Boolean));
  await mkdir(deadlinesDir, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(deadlinesDir, "index.html"),
      renderDeadlineRouteHtml(html, deadlineData.items),
      "utf8",
    ),
    writeFile(path.join(outputRoot, "robots.txt"), DEADLINES_ROBOTS_TEXT, "utf8"),
    writeFile(path.join(outputRoot, "sitemap.xml"), DEADLINES_SITEMAP_XML, "utf8"),
  ]);
  console.log("[vercel-postbuild] wrote crawlable /deadlines, /robots.txt, and /sitemap.xml");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[vercel-postbuild] ${err.stack || err}`);
    process.exit(1);
  });
}
