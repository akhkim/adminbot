import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  DEADLINES_PUBLIC_URL,
  DEADLINES_ROBOTS_TEXT,
  DEADLINES_SITEMAP_XML,
  renderDeadlineRouteHtml,
} from "../../scripts/vercel-postbuild-index.mjs";

const appHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>OpenClaw Control</title>
    <meta name="color-scheme" content="dark" />
  </head>
  <body>
    <openclaw-app></openclaw-app>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;

describe("Vercel deadline indexing", () => {
  it("pre-renders a sanitized fallback inside the existing Control UI shell", () => {
    const html = renderDeadlineRouteHtml(appHtml, [
      {
        name: "First Workshop",
        venue_group: "Workshops of Example 2035",
        deadline_label: "Submission",
        deadline_aoe: "2035-01-02 12:30:00",
        homepage_url: "https://example.com/workshop",
        private_paper_id: "must-not-render",
      },
      {
        name: '<script>alert("name")</script>',
        venue_group: '<img src=x onerror="alert(1)">',
        deadline_label: "<strong>submission</strong>",
        deadline_aoe: "2035-02-03 04:05:06",
        link: "javascript:alert(1)",
      },
    ]);
    const dom = new JSDOM(html);
    try {
      const { document } = dom.window;
      expect(document.title).toBe("Deadlines | Jinesis Lab");
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        DEADLINES_PUBLIC_URL,
      );
      expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
        "index, follow",
      );
      expect(document.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe(
        DEADLINES_PUBLIC_URL,
      );
      expect(document.querySelector('script[src="/assets/app.js"]')).not.toBeNull();
      expect(document.querySelector("#deadline-index-fallback-cleanup")?.textContent).toContain(
        "fallback.remove()",
      );

      const fallback = document.querySelector("openclaw-app > #deadline-index-fallback")!;
      expect(fallback.textContent).toContain("Past and upcoming conference & workshop deadlines.");
      expect(fallback.textContent).toContain("First Workshop");
      expect(fallback.textContent).toContain("2035-01-02 12:30 AoE");
      expect(fallback.querySelector('time[datetime="2035-01-02T12:30:00-12:00"]')).not.toBeNull();
      expect(fallback.textContent).toContain('<script>alert("name")</script>');
      expect(fallback.textContent).not.toContain("must-not-render");
      expect(fallback.querySelector("script")).toBeNull();
      expect(fallback.querySelector("img")).toBeNull();
      expect(fallback.querySelector("strong")).toBeNull();
      expect(fallback.querySelector('a[href^="javascript:"]')).toBeNull();
      expect(fallback.querySelector('a[href="https://example.com/workshop"]')).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it("publishes only the requested deadline URL as the crawl target", () => {
    expect(DEADLINES_PUBLIC_URL).toBe("https://jinesis-admin.vercel.app/deadlines");
    expect(DEADLINES_ROBOTS_TEXT).toMatch(/^Allow: \/deadlines$/mu);
    // The old prefixed path still resolves for existing links, but it is deliberately not
    // advertised to crawlers: two URLs serving one page is duplicate content.
    expect(DEADLINES_ROBOTS_TEXT).not.toMatch(/^Allow: \/adminbot\/deadlines$/mu);
    expect(DEADLINES_SITEMAP_XML).toContain(`<loc>${DEADLINES_PUBLIC_URL}</loc>`);
    expect(DEADLINES_SITEMAP_XML).not.toContain(
      "<loc>https://jinesis-admin.vercel.app/adminbot/deadlines</loc>",
    );
  });

  it("keeps the fallback until the native application mounts", async () => {
    const dom = new JSDOM(renderDeadlineRouteHtml(appHtml, []), { runScripts: "dangerously" });
    try {
      const host = dom.window.document.querySelector("openclaw-app")!;
      expect(host.querySelector("#deadline-index-fallback")).not.toBeNull();

      host.append(dom.window.document.createElement("div"));
      await new Promise((resolve) => {
        dom.window.queueMicrotask(resolve);
      });

      expect(host.querySelector("#deadline-index-fallback")).toBeNull();
      expect(dom.window.document.querySelector("#deadline-index-fallback-style")).toBeNull();
    } finally {
      dom.window.close();
    }
  });
});
