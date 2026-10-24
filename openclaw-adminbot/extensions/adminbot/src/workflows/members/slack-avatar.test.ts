import { describe, expect, it } from "vitest";
import { syntheticMember } from "../slides/face-layout.test-helpers.js";
import { hasFacePhoto } from "../slides/working-groups.js";
import { isSlackDefaultAvatar } from "./slack-avatar.js";

const GRAVATAR_SILHOUETTE =
  "https://secure.gravatar.com/avatar/0f1e.jpg?s=512&d=https%3A%2F%2Fa.slack-edge.com%2Fdf10d%2Fimg%2Favatars%2Fava_0013-512.png";

describe("isSlackDefaultAvatar", () => {
  it("recognises Slack's silhouette, through Gravatar or directly", () => {
    expect(isSlackDefaultAvatar(GRAVATAR_SILHOUETTE)).toBe(true);
    expect(isSlackDefaultAvatar("https://a.slack-edge.com/df10d/img/avatars/ava_0021-192.png")).toBe(true);
  });

  it("leaves uploaded photos and other hosts alone", () => {
    expect(isSlackDefaultAvatar("https://avatars.slack-edge.com/2026-01-02/123_abc_512.jpg")).toBe(false);
    expect(isSlackDefaultAvatar("https://secure.gravatar.com/avatar/0f1e.jpg?s=512&d=identicon")).toBe(false);
    expect(isSlackDefaultAvatar("https://example.com/img/avatars/ava_0001.png")).toBe(false);
    expect(isSlackDefaultAvatar(undefined)).toBe(false);
    expect(isSlackDefaultAvatar("https://slack-edge.com/%E0%A4%A")).toBe(false);
  });

  it("keeps silhouettes off the working-groups slide", () => {
    expect(hasFacePhoto(syntheticMember("a", "interp", { avatar_url: GRAVATAR_SILHOUETTE }))).toBe(false);
    expect(hasFacePhoto(syntheticMember("b", "interp", { avatar_url: "https://avatars.slack-edge.com/b.jpg" }))).toBe(
      true,
    );
  });
});
