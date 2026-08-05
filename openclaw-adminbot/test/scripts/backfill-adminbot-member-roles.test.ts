import { describe, expect, it } from "vitest";
import { adminBotMemberRoles } from "../../extensions/adminbot/src/contracts.js";
import {
  careerStageFromNotes,
  normalizeExistingRole,
  roleForCareerStage,
} from "../../scripts/backfill-adminbot-member-roles.js";

describe("careerStageFromNotes", () => {
  it("reads the survey line out of the shared keyed notes list", () => {
    const notes = [
      "Source: Quick-Start Survey for Research Mentees",
      "Career stage: PhD / MSc",
      "Affiliation: UToronto / ETH",
    ].join("\n");
    expect(careerStageFromNotes(notes)).toBe("PhD / MSc");
  });

  it("reports nothing when the member never answered", () => {
    expect(careerStageFromNotes("Affiliation: ETH")).toBe("");
    expect(careerStageFromNotes(undefined)).toBe("");
  });
});

describe("roleForCareerStage", () => {
  it("maps the stages the roster actually contains", () => {
    expect(roleForCareerStage("BS")).toBe("Undergraduate Student");
    expect(roleForCareerStage("MSc")).toBe("Master's Student");
    expect(roleForCareerStage("PhD")).toBe("PhD Student");
    expect(roleForCareerStage("Gap-year RA")).toBe("Research Assistant");
    expect(roleForCareerStage("Part-time RA")).toBe("Research Assistant");
    expect(roleForCareerStage("Member of Technical Staff")).toBe("Industry Researcher");
  });

  // A stage naming two levels describes someone who has moved on; the roster wants where they are.
  it("takes the senior half of a combined stage", () => {
    expect(roleForCareerStage("PhD / MSc")).toBe("PhD Student");
    expect(roleForCareerStage("PhD Mentee / MSc")).toBe("PhD Student");
  });

  it("is case- and space-insensitive", () => {
    expect(roleForCareerStage("  phd mentee  ")).toBe("PhD Student");
  });

  // A wrong role is worse than a missing one: anything unrecognised has to stay empty so a human
  // can answer it, rather than being guessed into the nearest bucket.
  it("returns nothing for a stage it does not recognise", () => {
    expect(roleForCareerStage("Visiting Fellow")).toBeUndefined();
    expect(roleForCareerStage("")).toBeUndefined();
  });

  it("only ever produces roles the vocabulary contains", () => {
    for (const stage of ["BS", "MSc", "PhD", "Gap-year RA", "Analyst"]) {
      const role = roleForCareerStage(stage);
      expect(adminBotMemberRoles).toContain(role);
    }
  });
});

describe("normalizeExistingRole", () => {
  // "PhD student" was typed before the list existed; it is the same answer, not an unknown one.
  it("recognises a role that differs only in case", () => {
    expect(normalizeExistingRole("PhD student")).toBe("PhD Student");
    expect(normalizeExistingRole("  professor ")).toBe("Professor");
  });

  it("leaves a genuinely different role unmatched", () => {
    expect(normalizeExistingRole("Chief Scientist")).toBeUndefined();
  });
});
