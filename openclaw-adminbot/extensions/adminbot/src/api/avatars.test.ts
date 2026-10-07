// Uploaded profile photos are stored inline as data URLs (up to ~700KB each). They leave the
// service as a content-addressed path instead, so a roster is kilobytes and the browser caches
// each photo once.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { avatarJsonReplacer, avatarJsonReviver, findAvatar } from "./avatars.js";

const PNG = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;

describe("avatar urls", () => {
  it("replaces inline raster photos with a stable content-addressed path", () => {
    const json = JSON.stringify(
      { members: [{ avatar_url: PNG }, { avatar_url: "https://avatars.slack-edge.com/a.png" }] },
      avatarJsonReplacer,
    );
    const [first, second] = (JSON.parse(json) as { members: Array<{ avatar_url: string }> })
      .members;
    expect(first.avatar_url).toMatch(/^\/avatars\/[0-9a-f]{64}$/);
    expect(JSON.stringify({ avatar_url: PNG }, avatarJsonReplacer)).toContain(first.avatar_url);
    expect(second.avatar_url).toBe("https://avatars.slack-edge.com/a.png");
  });

  it("leaves anything that is not a base64 raster image inline", () => {
    const svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    expect(JSON.parse(JSON.stringify({ avatar_url: svg }, avatarJsonReplacer))).toEqual({
      avatar_url: svg,
    });
    expect(JSON.parse(JSON.stringify({ photo: PNG }, avatarJsonReplacer))).toEqual({ photo: PNG });
  });

  it("finds the photo behind a path, from the members when the process has not served it yet", () => {
    const path = (
      JSON.parse(JSON.stringify({ avatar_url: PNG }, avatarJsonReplacer)) as {
        avatar_url: string;
      }
    ).avatar_url;
    const hash = path.slice("/avatars/".length);
    expect(findAvatar(hash, () => [])).toEqual({
      contentType: "image/png",
      bytes: Buffer.from("png-bytes"),
    });

    const jpeg = `data:image/jpeg;base64,${Buffer.from("fresh").toString("base64")}`;
    const unseen = createHash("sha256").update(jpeg).digest("hex");
    expect(findAvatar(unseen, () => [{ avatar_url: jpeg }])?.contentType).toBe("image/jpeg");
    expect(findAvatar("0".repeat(64), () => [{ avatar_url: jpeg }])).toBeUndefined();
    expect(findAvatar("../etc/passwd", () => [])).toBeUndefined();
  });

  it("turns an echoed path back into the stored photo, and drops one it cannot resolve", () => {
    const path = (
      JSON.parse(JSON.stringify({ avatar_url: PNG }, avatarJsonReplacer)) as {
        avatar_url: string;
      }
    ).avatar_url;
    expect(
      JSON.parse(
        JSON.stringify({ avatar_url: `https://adminbot.example.org${path}` }),
        avatarJsonReviver,
      ),
    ).toEqual({ avatar_url: PNG });
    // Unknown: leaving the field out means "unchanged", never a link to a photo that is gone.
    expect(
      JSON.parse(JSON.stringify({ avatar_url: `/avatars/${"1".repeat(64)}` }), avatarJsonReviver),
    ).toEqual({});
    expect(
      JSON.parse(JSON.stringify({ avatar_url: "https://example.org/me.png" }), avatarJsonReviver),
    ).toEqual({ avatar_url: "https://example.org/me.png" });
  });
});
