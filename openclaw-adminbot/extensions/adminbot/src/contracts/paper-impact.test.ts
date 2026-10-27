// The impact-statement contract on synthetic papers: what the quick check calls safety work, what
// state a statement is in, and who may change which part of it.
import { describe, expect, it } from "vitest";
import {
  classifyPaperSafety,
  mergePaperImpactWrite,
  paperImpactApprovalBlock,
  paperImpactStatus,
  parsePaperImpactStatement,
  type PaperImpactStatement,
} from "./paper-impact.js";

const NOW = "2026-10-26T12:00:00.000Z";

const written: PaperImpactStatement = {
  risk: "Models comply with disguised harmful requests.",
  intervention: "A refusal probe catches the disguise before generation.",
  users: "Deployment teams would gate releases on the probe.",
};

function merge(
  valueText: unknown,
  options: {
    existing?: PaperImpactStatement | null;
    isHeadProfessor?: boolean;
    privileged?: boolean;
  } = {},
) {
  return mergePaperImpactWrite({
    existing: options.existing ?? null,
    valueText: typeof valueText === "string" ? valueText : JSON.stringify(valueText),
    memberId: options.isHeadProfessor ? "pi" : "ada",
    isHeadProfessor: options.isHeadProfessor ?? false,
    privileged: options.privileged ?? false,
    now: NOW,
  });
}

describe("classifyPaperSafety", () => {
  it("calls a paper related on a strong term, and says which", () => {
    expect(classifyPaperSafety({ title: "Jailbreak transfer across model families" })).toEqual({
      verdict: "related",
      reasons: ["jailbreak"],
    });
  });

  it("leaves weak terms alone as uncertain rather than guessing", () => {
    expect(classifyPaperSafety({ title: "Robustness of tabular models" }).verdict).toBe(
      "uncertain",
    );
  });

  it("calls a paper with no match unrelated", () => {
    expect(classifyPaperSafety({ title: "Faster sparse attention kernels" })).toEqual({
      verdict: "unrelated",
      reasons: [],
    });
  });

  it("reads the record's notes and venue, not just the title", () => {
    expect(
      classifyPaperSafety({ title: "Probing study", notes: "Focus: scalable oversight" }).verdict,
    ).toBe("related");
  });

  it("does not match a term inside another word", () => {
    // "harm" must not fire on "pharmacology".
    expect(classifyPaperSafety({ title: "Pharmacology benchmarks" }).verdict).toBe("unrelated");
  });
});

describe("paperImpactStatus", () => {
  const related = { title: "Red teaming agents" };

  it("walks a required statement through missing, draft, awaiting review and reviewed", () => {
    expect(paperImpactStatus(related, null).state).toBe("missing");
    expect(paperImpactStatus(related, { risk: "x" })).toMatchObject({
      state: "draft",
      missing: ["intervention", "users"],
    });
    expect(paperImpactStatus(related, written).state).toBe("awaiting_review");
    expect(paperImpactStatus(related, { ...written, reviewed: true }).state).toBe("reviewed");
  });

  it("keeps the statement optional when the paper is unrelated or the check is unsure", () => {
    expect(paperImpactStatus({ title: "Sparse kernels" }, null)).toMatchObject({
      state: "not_required",
      required: false,
    });
    expect(paperImpactStatus({ title: "Fairness audits" }, null)).toMatchObject({
      state: "unresolved",
      required: false,
    });
  });

  it("lets a person's correction win over the classifier, both ways", () => {
    const off = paperImpactStatus(related, {
      safety: { verdict: "unrelated", by: "pi", at: NOW, reason: "Games, not models" },
    });
    expect(off).toMatchObject({
      state: "not_required",
      source: "override",
      reasons: ["Games, not models"],
    });
    const on = paperImpactStatus(
      { title: "Fairness audits" },
      { safety: { verdict: "related", by: "pi", at: NOW } },
    );
    expect(on).toMatchObject({ state: "missing", required: true, source: "override" });
  });
});

describe("paperImpactApprovalBlock", () => {
  it("holds publication approval only while a required statement is unwritten", () => {
    const related = { title: "Reward hacking in coding agents" };
    expect(paperImpactApprovalBlock(paperImpactStatus(related, null))).toMatch(/impact statement/);
    expect(paperImpactApprovalBlock(paperImpactStatus(related, { risk: "x" }))).not.toBeNull();
    expect(paperImpactApprovalBlock(paperImpactStatus(related, written))).toBeNull();
    expect(paperImpactApprovalBlock(paperImpactStatus({ title: "Fairness" }, null))).toBeNull();
  });
});

describe("parsePaperImpactStatement", () => {
  it("reads a malformed row as no statement", () => {
    expect(parsePaperImpactStatement("not json")).toBeNull();
    expect(parsePaperImpactStatement(JSON.stringify({ risk: 3 }))).toBeNull();
    expect(parsePaperImpactStatement(JSON.stringify({ reviewed: "yes" }))).toBeNull();
  });
});

describe("mergePaperImpactWrite", () => {
  it("saves an author's partial draft", () => {
    expect(merge({ risk: "  A risk.  " })).toEqual({ ok: true, statement: { risk: "A risk." } });
  });

  it("refuses an author marking their own statement reviewed", () => {
    expect(merge({ ...written, reviewed: true })).toMatchObject({ ok: false, status: 403 });
  });

  it("lets the head professor mark it reviewed with a note, stamped", () => {
    expect(
      merge({ ...written, reviewed: true, review_note: "Clear." }, { isHeadProfessor: true }),
    ).toEqual({
      ok: true,
      statement: {
        ...written,
        reviewed: true,
        reviewed_by: "pi",
        reviewed_at: NOW,
        review_note: "Clear.",
      },
    });
  });

  it("carries the review over an author's resave of the same text", () => {
    const existing = { ...written, reviewed: true, reviewed_by: "pi", reviewed_at: NOW };
    expect(merge(written, { existing })).toEqual({ ok: true, statement: existing });
  });

  it("reopens the review when the text changes, keeping the PI's note", () => {
    const existing = { ...written, reviewed: true, review_note: "Clear." };
    const result = merge({ ...written, users: "Auditors." }, { existing });
    expect(result).toEqual({
      ok: true,
      statement: { ...written, users: "Auditors.", review_note: "Clear." },
    });
  });

  it("keeps a correction an author's form did not send", () => {
    const safety = { verdict: "unrelated" as const, by: "pi", at: NOW };
    expect(merge({ risk: "x" }, { existing: { safety } })).toEqual({
      ok: true,
      statement: { risk: "x", safety },
    });
  });

  it("lets only the head professor or an admin correct the classification", () => {
    const correction = { safety: { verdict: "unrelated", reason: "Not ML" } };
    expect(merge(correction)).toMatchObject({ ok: false, status: 403 });
    expect(merge(correction, { privileged: true })).toEqual({
      ok: true,
      statement: { safety: { verdict: "unrelated", by: "ada", at: NOW, reason: "Not ML" } },
    });
    expect(merge(correction, { isHeadProfessor: true })).toMatchObject({ ok: true });
  });

  it("lets an author resend the correction already on file unchanged", () => {
    const safety = { verdict: "unrelated" as const, by: "pi", at: NOW };
    expect(merge({ safety: { verdict: "unrelated" } }, { existing: { safety } })).toEqual({
      ok: true,
      statement: { safety },
    });
  });

  it("rejects non-objects and over-long prompts", () => {
    expect(merge("[1]")).toMatchObject({ ok: false, status: 400 });
    expect(merge({ risk: "x".repeat(4001) })).toMatchObject({ ok: false, status: 400 });
  });
});
