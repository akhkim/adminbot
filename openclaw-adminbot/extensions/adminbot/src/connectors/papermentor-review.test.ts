// What the lab's Overleaf says to a review request, as AdminBot reads it.
import { describe, expect, it } from "vitest";
import {
  createPaperMentorReviewRequester,
  paperMentorReviewRequesterFromEnv,
} from "./papermentor-review.js";

const PROJECT = "65f2a1c9d4e3b7a801f6abcd";
const SHARE = "https://overleaf.safe.eu/1234567890abcdefghijkl";

function answering(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return {
    calls,
    request: createPaperMentorReviewRequester({
      origin: "https://overleaf.safe.eu/",
      token: "s3cret",
      fetchImpl,
    }),
  };
}

describe("createPaperMentorReviewRequester", () => {
  it("sends the share link to the configured Overleaf with the shared secret", async () => {
    const { calls, request } = answering(202, { project_id: PROJECT, status: "started" });

    expect(await request({ share_link: SHARE }, { venue: "iclr_2026" })).toEqual({
      status: "started",
      project_id: PROJECT,
    });
    const [call] = calls;
    if (!call) {
      throw new Error("no request was made");
    }
    expect(call.url).toBe("https://overleaf.safe.eu/internal/papermentor/review");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(JSON.parse(String(call.init.body))).toEqual({
      share_link: SHARE,
      venue: "iclr_2026",
    });
  });

  it("reads each refusal as what it means for the paper", async () => {
    const cases: Array<[number, unknown, string]> = [
      [409, { project_id: PROJECT, status: "running" }, "running"],
      [409, { project_id: PROJECT, status: "recent" }, "recent"],
      [429, { project_id: PROJECT, status: "busy" }, "busy"],
      [404, { error: "No project on this Overleaf shares that link" }, "not_found"],
      [400, { error: "share_link is not an Overleaf edit share link" }, "rejected"],
      [401, { error: "Unauthorized" }, "failed"],
      [503, { error: "Automated reviews are not enabled" }, "failed"],
    ];
    for (const [status, body, expected] of cases) {
      const { request } = answering(status, body);
      expect((await request({ share_link: SHARE })).status).toBe(expected);
    }
  });

  it("carries back only a real project id", async () => {
    const { request } = answering(202, { project_id: "../../etc", status: "started" });
    expect(await request({ share_link: SHARE })).toEqual({ status: "started" });
  });

  it("reports an Overleaf it could not reach as a failure, not a paper's problem", async () => {
    const request = createPaperMentorReviewRequester({
      origin: "https://overleaf.safe.eu",
      token: "s3cret",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await request({ project_id: PROJECT })).toEqual({
      status: "failed",
      message: "ECONNREFUSED",
    });
  });
});

describe("paperMentorReviewRequesterFromEnv", () => {
  it("is off until the shared secret is set", () => {
    expect(paperMentorReviewRequesterFromEnv({})).toBeUndefined();
    expect(
      paperMentorReviewRequesterFromEnv({ ADMINBOT_PAPERMENTOR_SERVICE_TOKEN: " " }),
    ).toBeUndefined();
    expect(
      paperMentorReviewRequesterFromEnv({ ADMINBOT_PAPERMENTOR_SERVICE_TOKEN: "s3cret" }),
    ).toBeTypeOf("function");
  });
});
