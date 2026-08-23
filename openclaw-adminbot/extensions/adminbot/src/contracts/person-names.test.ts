import { describe, expect, it } from "vitest";
import { isSamePerson, normalizePersonName, toFirstLast } from "./person-names.js";

describe("matching an author entry to a roster name", () => {
  it("ignores an equal-contribution marker", () => {
    // The bug this exists for: a co-first author was invisible on their own paper, because the
    // author list said "Joeun Yook*" and the roster said "Joeun Yook".
    expect(isSamePerson("Joeun Yook*", "Joeun Yook")).toBe(true);
    expect(isSamePerson("Joeun Yook†", "Joeun Yook")).toBe(true);
    expect(isSamePerson("Punya Syon Pandey¹", "Punya Syon Pandey")).toBe(true);
  });

  it("ignores diacritics the two records spell differently", () => {
    expect(isSamePerson("Bernhard Schölkopf", "Bernhard Scholkopf")).toBe(true);
    expect(isSamePerson("Samuel Šimko", "Samuel Simko")).toBe(true);
  });

  it("flips a BibTeX-style 'Last, First' entry", () => {
    expect(isSamePerson("Yook, Joeun", "Joeun Yook")).toBe(true);
  });

  it("survives stray whitespace inside the name", () => {
    expect(isSamePerson("Joeun  Yook", "Joeun Yook")).toBe(true);
  });

  it("still says no to a different person", () => {
    // Blunt folding must not turn everyone into everyone else.
    expect(isSamePerson("Andrew Yook", "Joeun Yook")).toBe(false);
    expect(isSamePerson("Joeun Kim", "Joeun Yook")).toBe(false);
  });

  it("does not match on an initial alone", () => {
    // Deliberately stricter than the draft's author verifier: this decides whose work list a
    // paper lands on, so a wrong match shows somebody another person's paper.
    expect(isSamePerson("J. Yook", "Joeun Yook")).toBe(false);
  });

  it("treats an empty or punctuation-only entry as nobody", () => {
    expect(isSamePerson("", "Joeun Yook")).toBe(false);
    expect(isSamePerson("*", "Joeun Yook")).toBe(false);
    expect(isSamePerson("Joeun Yook", "")).toBe(false);
  });

  it("exposes the parts the draft verifier builds on", () => {
    expect(normalizePersonName("Joeun Yook*")).toBe("joeun yook");
    expect(toFirstLast("Jin, Zhijing")).toBe("Zhijing Jin");
  });
});

describe("a middle name on one side only", () => {
  it("matches the full signature against the short roster name", () => {
    // The case this exists for: five EMNLP submissions signed "Terry Jingchen Zhang" against a
    // roster that says "Terry Zhang". Without this the duty silently moved to the next author.
    expect(isSamePerson("Terry Jingchen Zhang", "Terry Zhang")).toBe(true);
    expect(isSamePerson("Zhang, Terry Jingchen", "Terry Zhang")).toBe(true);
    expect(isSamePerson("Punya Syon Pandey", "Punya Pandey")).toBe(true);
  });

  it("still refuses two different people", () => {
    expect(isSamePerson("Terry Jingchen Zhang", "Terry Chen")).toBe(false);
    expect(isSamePerson("Terry Zhang", "Jingchen Zhang")).toBe(false);
    // Two different middle names is two people, not one.
    expect(isSamePerson("Terry Jingchen Zhang", "Terry Wei Zhang")).toBe(false);
    // An initial is not a name.
    expect(isSamePerson("T. Zhang", "Terry Zhang")).toBe(false);
  });
});

