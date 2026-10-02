// The ids these links carry, and when two titles are the same paper.
import { describe, expect, it } from "vitest";
import {
  adminBotArxivId,
  adminBotOpenReviewForumId,
  adminBotTitlesLookLikeTheSamePaper,
} from "./paper-artifact-links.js";

describe("adminBotArxivId", () => {
  it("reads the abstract page, the PDF and the bare form", () => {
    expect(adminBotArxivId("https://arxiv.org/abs/2601.00001")).toBe("2601.00001");
    expect(adminBotArxivId("https://arxiv.org/pdf/2601.00001v2")).toBe("2601.00001v2");
    expect(adminBotArxivId("https://arxiv.org/pdf/2601.00001.pdf")).toBe("2601.00001");
    expect(adminBotArxivId("https://www.arxiv.org/abs/2601.00001")).toBe("2601.00001");
  });

  // "Which version did the lab post" is a real question, and dropping the suffix would make two
  // different PDFs answer to one record.
  it("keeps the version", () => {
    expect(adminBotArxivId("https://arxiv.org/abs/2601.00001v3")).toBe("2601.00001v3");
  });

  it("reads the pre-2007 archive form", () => {
    expect(adminBotArxivId("https://arxiv.org/abs/math.GT/0605123")).toBe("math.GT/0605123");
    expect(adminBotArxivId("https://arxiv.org/abs/hep-th/0605123")).toBe("hep-th/0605123");
  });

  it("refuses anything that is not an arXiv paper", () => {
    for (const url of [
      "https://arxiv.org/list/cs.CL/recent",
      "https://evil.example/abs/2601.00001",
      "http://arxiv.org/abs/2601.00001",
      "https://arxiv.org/abs/not-an-id",
      "",
    ]) {
      expect(adminBotArxivId(url)).toBeUndefined();
    }
  });
});

describe("adminBotOpenReviewForumId", () => {
  it("reads the forum and PDF links", () => {
    expect(adminBotOpenReviewForumId("https://openreview.net/forum?id=Ax7Kq2Lm9P")).toBe(
      "Ax7Kq2Lm9P",
    );
    expect(adminBotOpenReviewForumId("https://openreview.net/pdf?id=Ax7Kq2Lm9P")).toBe(
      "Ax7Kq2Lm9P",
    );
  });

  // Every other venue: CMT, HotCRP, a conference's own site. There is no id shape to read, and the
  // caller treats that as "nothing to ask" rather than as a bad link.
  it("says nothing about a submission somewhere else", () => {
    expect(
      adminBotOpenReviewForumId("https://cmt3.research.microsoft.com/ACL2027"),
    ).toBeUndefined();
    expect(adminBotOpenReviewForumId("https://openreview.net/group?id=ICLR.cc")).toBeUndefined();
  });
});

describe("adminBotTitlesLookLikeTheSamePaper", () => {
  it("survives the ways a title is rewritten between a draft and a listing", () => {
    expect(
      adminBotTitlesLookLikeTheSamePaper(
        "Causal Garden Planning: A Benchmark",
        "Causal garden planning -- a benchmark for agents",
      ),
    ).toBe(true);
    expect(
      adminBotTitlesLookLikeTheSamePaper(
        "Causal Garden Planning",
        "{Causal} \\emph{Garden} Planning",
      ),
    ).toBe(true);
  });

  // The mistake worth catching: a link to somebody else's paper.
  it("catches a title with nothing to do with the paper", () => {
    expect(
      adminBotTitlesLookLikeTheSamePaper(
        "Causal Garden Planning",
        "Attention Is All You Need For Machine Translation",
      ),
    ).toBe(false);
  });

  it("says nothing rather than complaining when there is nothing to compare", () => {
    expect(adminBotTitlesLookLikeTheSamePaper("", "Causal Garden Planning")).toBe(true);
  });
});
