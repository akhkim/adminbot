import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { createAdminBotSocialExecutor, type SocialFetch } from "./social.js";

function proposal(payload: unknown): AdminBotStoredProposal {
  return {
    id: "act_1",
    type: "social_media.post_publicly",
    risk_tier: "T4",
    summary: "Publish social posts",
    proposed_payload: payload,
    payload_hash: "sha256:test",
    status: "approved",
    approval_requirement: { requires_approval: true, approver_roles: ["pi"], min_approvals: 1 },
    approvals: [{ approver_role: "pi" }],
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
  };
}

describe("AdminBot social executor", () => {
  it("posts LinkedIn content and X thread posts through platform APIs", async () => {
    const calls: Array<{ url: string; body?: unknown; headers?: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input, init) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(init.body) : undefined,
        headers: init?.headers,
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return String(input).includes("api.x.com")
            ? JSON.stringify({ data: { id: `tweet_${calls.length}` } })
            : JSON.stringify({ id: "urn:li:share:1" });
        },
      };
    }) as SocialFetch;
    const executor = createAdminBotSocialExecutor({
      fetchImpl,
      env: {
        LINKEDIN_ACCESS_TOKEN: "linkedin-token",
        LINKEDIN_AUTHOR_URN: "urn:li:organization:123",
        X_ACCESS_TOKEN: "x-token",
      },
    });

    await expect(
      executor.execute(
        proposal({
          action: "publish_paper_social_posts",
          platforms: ["linkedin", "x"],
          paper: { title: "Paper", summary: "Summary", authors: ["Pat"] },
          tags: {
            resolved: [{ name: "Pat", x_handle: "@pat", linkedin_tag: "@pat" }],
            missing: [],
          },
          linkedin: { text: "LinkedIn post", visibility: "PUBLIC" },
          x: { posts: ["First", "Second"] },
        }),
      ),
    ).resolves.toEqual({ handled: true });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.linkedin.com/rest/posts",
      "https://api.x.com/2/tweets",
      "https://api.x.com/2/tweets",
    ]);
    expect(calls[0]?.body).toMatchObject({
      author: "urn:li:organization:123",
      commentary: "LinkedIn post",
    });
    expect(calls[2]?.body).toMatchObject({ reply: { in_reply_to_tweet_id: "tweet_2" } });
  });

  it("refuses to post when required tags are missing", async () => {
    const executor = createAdminBotSocialExecutor({
      fetchImpl: vi.fn() as SocialFetch,
      env: {
        LINKEDIN_ACCESS_TOKEN: "token",
        LINKEDIN_AUTHOR_URN: "urn:li:person:1",
        X_ACCESS_TOKEN: "x",
      },
    });

    await expect(
      executor.execute(
        proposal({
          action: "publish_paper_social_posts",
          platforms: ["x"],
          paper: { title: "Paper", summary: "Summary", authors: ["Pat"] },
          tags: { resolved: [], missing: [{ name: "Pat", platform: "x", reason: "missing" }] },
          x: { posts: ["Post"] },
        }),
      ),
    ).rejects.toThrow(/missing required tags/u);
  });
});
