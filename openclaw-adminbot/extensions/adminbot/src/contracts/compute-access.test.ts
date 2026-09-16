import { describe, expect, it } from "vitest";
import {
  adminBotAllComputeAccessValues,
  adminBotComputeAccessRegistry,
  adminBotComputeAccessValues,
  adminBotReservedComputeAccessValues,
  formatComputeAccessCell,
  isAdminBotComputeAccess,
  isProvisionedComputeAccess,
  newcomerSafeComputeAccess,
  normalizeComputeAccess,
} from "./compute-access.js";

describe("the vocabulary", () => {
  it("declares every value, so a cell can never meet one it has no rules for", () => {
    for (const value of adminBotAllComputeAccessValues) {
      expect(adminBotComputeAccessRegistry[value]).toBeDefined();
    }
    expect(adminBotAllComputeAccessValues).toHaveLength(
      adminBotComputeAccessValues.length + adminBotReservedComputeAccessValues.length,
    );
  });

  it("never lists a value as both live and reserved", () => {
    // The two lists are what "can the lab grant this" is read from. A value in both would make
    // that question answerable two ways.
    for (const value of adminBotReservedComputeAccessValues) {
      expect(adminBotComputeAccessValues as readonly string[]).not.toContain(value);
    }
  });

  it("agrees with itself about which values are provisioned", () => {
    for (const value of adminBotComputeAccessValues) {
      expect(adminBotComputeAccessRegistry[value].provisioned, value).toBe(true);
    }
    for (const value of adminBotReservedComputeAccessValues) {
      expect(adminBotComputeAccessRegistry[value].provisioned, value).toBe(false);
    }
  });

  it("gives every access that costs somebody else a reason, and the safe ones none", () => {
    // `sharedCost` is the sentence a reviewer sees when deciding whether a newcomer gets this.
    // Marking something unsafe without saying why makes that decision unanswerable.
    for (const value of adminBotAllComputeAccessValues) {
      const definition = adminBotComputeAccessRegistry[value];
      if (definition.newcomerSafe) {
        expect(definition.sharedCost, value).toBeUndefined();
      } else {
        expect(definition.sharedCost, value).toBeTruthy();
      }
    }
  });

  it("knows which access is safe to hand a newcomer", () => {
    const safe = newcomerSafeComputeAccess();
    // The two the source doc calls out by name.
    expect(safe).toContain("vector-basic-A100");
    expect(safe).toContain("UofT-RTX6000-test");
    // The shared-credit pool is the canonical unsafe one: one person's runaway job spends the
    // whole group's allocation.
    expect(safe).not.toContain("compute-canada-def");
    expect(safe).not.toContain("UofT-H100");
  });
});

describe("recognising a value", () => {
  it("accepts live and reserved alike, and refuses anything else", () => {
    expect(isAdminBotComputeAccess("UofT-H100")).toBe(true);
    expect(isAdminBotComputeAccess("compute-canada-rrg")).toBe(true);
    expect(isAdminBotComputeAccess("UofT-h100")).toBe(false);
    expect(isAdminBotComputeAccess("")).toBe(false);
  });

  it("separates 'spellable' from 'grantable'", () => {
    // A reserved value is vocabulary the sheet accepts, never a claim the lab can provision it.
    expect(isProvisionedComputeAccess("UofT-AI-Slurm")).toBe(true);
    expect(isProvisionedComputeAccess("vector-killarney")).toBe(false);
  });
});

describe("normalising a member's access", () => {
  it("orders by the vocabulary rather than by however the cells were typed", () => {
    // Two members with the same access must produce the same cell, or the diff against the sheet
    // is noise the sysadmin has to read past.
    expect(normalizeComputeAccess(["UofT-H100", "UofT-slack-only", "UofT-AI-Slurm"])).toEqual([
      "UofT-slack-only",
      "UofT-AI-Slurm",
      "UofT-H100",
    ]);
  });

  it("drops duplicates, blank cells and anything it does not recognise", () => {
    expect(normalizeComputeAccess(["UofT-cslab", " UofT-cslab ", "", "UofT-quantum-rig"])).toEqual([
      "UofT-cslab",
    ]);
  });
});

describe("the permission cell", () => {
  it("writes multiple choices comma-separated", () => {
    expect(formatComputeAccessCell(["UofT-AI-Slurm", "UofT-slack-only"])).toBe(
      "UofT-slack-only, UofT-AI-Slurm",
    );
  });

  it("writes a removal on its own, never beside an access level", () => {
    // A row that claimed both would ask the sysadmin which half to act on. The doc's own monthly
    // pass downgrades *or* deletes; it never does both to one person.
    expect(formatComputeAccessCell(["UofT-AI-Slurm", "UofT-total-deletion"])).toBe(
      "UofT-total-deletion",
    );
  });

  it("is empty for somebody with no access on file", () => {
    expect(formatComputeAccessCell([])).toBe("");
  });
});
