import { describe, expect, it, vi } from "vitest";
import { createOpenReviewSubmissionReader, toSubmission } from "./openreview-submissions.js";

const env = { OPENREVIEW_USERNAME: "synthetic@example.test", OPENREVIEW_PASSWORD: "synthetic" };

function note(id: string, content: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    forum: id,
    tmdate: 10,
    content: Object.fromEntries(Object.entries(content).map(([k, v]) => [k, { value: v }])),
    ...extra,
  };
}

function fakeOpenReview(notes: unknown[], options: { expireFirstToken?: boolean } = {}) {
  let logins = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/login") {
      logins++;
      return Response.json({
        token: `token-${logins}`,
        user: { profile: { id: "~Synthetic_Author1" } },
      });
    }
    const auth = new Headers(init?.headers).get("Authorization");
    if (options.expireFirstToken && auth === "Bearer token-1") {
      return new Response("expired", { status: 401 });
    }
    if (url.pathname === "/notes") {
      expect(url.searchParams.get("content.authorids")).toBe("~Synthetic_Author1");
      return Response.json({ notes });
    }
    if (url.pathname === "/pdf") {
      return new Response(url.searchParams.get("id") === "notapdf1" ? "<html>" : "%PDF-synthetic");
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl, logins: () => logins };
}

describe("OpenReview submission reader", () => {
  it("is absent without credentials", () => {
    expect(createOpenReviewSubmissionReader({ env: {} })).toBeUndefined();
  });

  it("lists root submissions with a PDF that can still be desk rejected", async () => {
    const { fetchImpl } = fakeOpenReview([
      note("activeAAA", {
        title: "Active",
        pdf: "/pdf/aaa.pdf",
        venueid: "Synthetic.cc/2027/Conference/Submission",
      }),
      note("noPdfBBB", {
        title: "Abstract only",
        venueid: "Synthetic.cc/2027/Conference/Submission",
      }),
      note("withdrawn", {
        title: "Gone",
        pdf: "/pdf/c.pdf",
        venueid: "Synthetic.cc/2027/Conference/Withdrawn_Submission",
      }),
      note("deskrejct", {
        title: "Rejected",
        pdf: "/pdf/d.pdf",
        venueid: "synthetic.org/ARR/2026/August/Desk_Rejected_Submission",
      }),
      note("replyEEEE", { title: "A review", pdf: "/pdf/e.pdf" }, { forum: "activeAAA" }),
    ]);
    const reader = createOpenReviewSubmissionReader({ env, fetchImpl })!;
    expect(await reader.profileId()).toBe("~Synthetic_Author1");
    expect(await reader.listSubmissions()).toEqual([
      {
        id: "activeAAA",
        title: "Active",
        venue_id: "Synthetic.cc/2027/Conference/Submission",
        pdf_path: "/pdf/aaa.pdf",
        modified_at: 10,
      },
    ]);
  });

  it("downloads PDFs with the account's token from the fixed endpoint only", async () => {
    const { fetchImpl } = fakeOpenReview([]);
    const reader = createOpenReviewSubmissionReader({ env, fetchImpl })!;
    expect(Buffer.from(await reader.readPdf("activeAAA")).toString()).toBe("%PDF-synthetic");
    const [url, init] = fetchImpl.mock.calls.at(-1)!;
    expect(String(url)).toBe("https://api2.openreview.net/pdf?id=activeAAA");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
    expect(init?.redirect).toBe("error");
    await expect(reader.readPdf("notapdf1")).rejects.toThrow("did not return a PDF");
    await expect(reader.readPdf("https://evil.example/x.pdf")).rejects.toThrow(
      "Expected an OpenReview submission ID",
    );
  });

  it("logs in again once when a long sweep's token expires", async () => {
    const { fetchImpl, logins } = fakeOpenReview([], { expireFirstToken: true });
    const reader = createOpenReviewSubmissionReader({ env, fetchImpl })!;
    expect(await reader.listSubmissions()).toEqual([]);
    expect(logins()).toBe(2);
  });

  it("reports a rejected login without echoing the credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 }));
    const reader = createOpenReviewSubmissionReader({ env, fetchImpl })!;
    const error = await reader.listSubmissions().catch((e: Error) => e);
    expect(String(error)).toContain("OpenReview rejected the login (403)");
    expect(String(error)).not.toContain(env.OPENREVIEW_PASSWORD + "@");
    expect(String(error)).not.toContain(env.OPENREVIEW_USERNAME);
  });

  it("keeps the author ids in author order", () => {
    expect(
      toSubmission({
        id: "x1234",
        content: {
          title: { value: "A paper" },
          pdf: { value: "/pdf/x.pdf" },
          venueid: { value: "ICLR.cc/2027/Conference/Submission" },
          authorids: { value: ["~Ada_Lovelace1", " ada@example.test ", 7, ""] },
        },
      }),
    ).toMatchObject({ author_ids: ["~Ada_Lovelace1", "ada@example.test"] });
  });

  // ICLR 2027 leaves `authorids` empty and gives each author as an object. Reading only the old
  // shape found no authors on those papers, so the integrity alert could reach nobody but the PI.
  it("reads names and ids from ICLR 2027's author objects", () => {
    expect(
      toSubmission({
        id: "x1234",
        content: {
          title: { value: "A paper" },
          pdf: { value: "/pdf/x.pdf" },
          venueid: { value: "ICLR.cc/2027/Conference/Submission" },
          authorids: { value: [] },
          authors: {
            value: [
              { username: "~Ada_Lovelace1", fullname: "Ada Lovelace", institutions: [] },
              { username: "~Grace_Hopper1", fullname: "Grace Hopper" },
              { fullname: "  " },
            ],
          },
        },
      }),
    ).toMatchObject({
      author_ids: ["~Ada_Lovelace1", "~Grace_Hopper1"],
      author_names: ["Ada Lovelace", "Grace Hopper"],
    });
  });

  it("keeps plain-string author names from older venues", () => {
    expect(
      toSubmission({
        id: "x1234",
        content: {
          title: { value: "A paper" },
          pdf: { value: "/pdf/x.pdf" },
          venueid: { value: "ICLR.cc/2025/Conference/Submission" },
          authorids: { value: ["~Ada_Lovelace1"] },
          authors: { value: ["Ada Lovelace"] },
        },
      }),
    ).toMatchObject({ author_ids: ["~Ada_Lovelace1"], author_names: ["Ada Lovelace"] });
  });

  it("ignores notes without an id or title", () => {
    expect(toSubmission(null)).toBeUndefined();
    expect(
      toSubmission({ id: "x1234", content: { pdf: { value: "/pdf/x.pdf" } } }),
    ).toBeUndefined();
  });
});
