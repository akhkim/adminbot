// The onboarding batch tool's two safety-shaped behaviours: which entries it refuses to send, and
// which of --no-email / --redirect-to a run is in. Both decide whether real mail reaches a real
// applicant, so they are worth pinning without a Gmail account anywhere near the test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPlan,
  parseArgs,
} from "../../scripts/adminbot-onboarding-dry-run.js";

function planFile(contents: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-plan-"));
  const file = path.join(dir, "plan.json");
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

describe("parseArgs", () => {
  it("requires --yes alongside --send", () => {
    expect(() => parseArgs(["--plan", "p.json", "--send"])).toThrow(/--yes/u);
  });

  it("refuses --no-email together with --redirect-to", () => {
    expect(() =>
      parseArgs([
        "--plan",
        "p.json",
        "--no-email",
        "--redirect-to",
        "a@b.test",
      ]),
    ).toThrow(/mutually exclusive/u);
  });

  it("refuses a --redirect-to that is not an address", () => {
    expect(() =>
      parseArgs(["--plan", "p.json", "--redirect-to", "andrew"]),
    ).toThrow(/needs an address/u);
  });

  it("reads both modes off the argv", () => {
    expect(parseArgs(["--plan", "p.json", "--no-email"]).noEmail).toBe(true);
    expect(
      parseArgs(["--plan", "p.json", "--redirect-to", "a@b.test"]).redirectTo,
    ).toBe("a@b.test");
    expect(parseArgs(["--plan", "p.json"]).noEmail).toBe(false);
  });
});

describe("loadPlan", () => {
  it("still reads the flat array the tool was written for", () => {
    const file = planFile([
      { template_id: "alumni", name: "Ada", email: "ada@example.test" },
    ]);
    expect(loadPlan(file).sends).toHaveLength(1);
  });

  // The composed-email files the lab produces are grouped by cohort and carry rendered copy. Taking
  // them directly means the file somebody reviewed is the file that goes out.
  it("reads the grouped composed-email file, mapping copy onto the overrides", () => {
    const file = planFile({
      generated_at: "2026-08-29T06:13:24.424Z",
      direct_matching: [
        {
          sheet_row: 169,
          name: "Youssef",
          email: "y@example.test",
          template_id: "interview_invite_project_matching",
          subject: "Jinesis Lab: Takehome Test Task(s)",
          body: "Hi Youssef!",
          cc: ["lead@cs.toronto.edu"],
          reply_to: "akim@cs.toronto.edu",
          needs: [],
        },
      ],
      test_onboard_3: [
        {
          name: "Yuen",
          email: "yuen@example.test",
          template_id: "alumni",
          subject: "Staying Connected",
          body: "Hi Yuen,",
          needs: [],
        },
      ],
    });
    const { sends } = loadPlan(file);
    expect(sends.map((entry) => entry.email)).toEqual([
      "y@example.test",
      "yuen@example.test",
    ]);
    expect(sends[0]?.subject_override).toBe(
      "Jinesis Lab: Takehome Test Task(s)",
    );
    expect(sends[0]?.body_override).toBe("Hi Youssef!");
    expect(sends[0]?.cc).toEqual(["lead@cs.toronto.edu"]);
    expect(sends[0]?.reply_to).toBe("akim@cs.toronto.edu");
  });

  // `needs` is the composer's record of a question it could not answer. Sending while one is open
  // is how a mail reaches the wrong applicant -- the live file has two entries on one sheet row
  // whose application documents were crossed.
  it("drops an entry with unresolved needs and says who", () => {
    const file = planFile({
      direct_matching: [
        {
          name: "Emile",
          email: "e@example.test",
          template_id: "t",
          needs: ["confirm the pairing"],
        },
        { name: "Clear", email: "c@example.test", template_id: "t", needs: [] },
      ],
    });
    const { sends, skipped } = loadPlan(file);
    expect(sends.map((entry) => entry.email)).toEqual(["c@example.test"]);
    expect(skipped).toEqual([
      { name: "Emile", email: "e@example.test", reason: "confirm the pairing" },
    ]);
  });

  it("ignores the file's own skipped bucket", () => {
    const file = planFile({
      direct_matching: [
        { name: "A", email: "a@example.test", template_id: "t", needs: [] },
      ],
      skipped: [
        {
          sheet_row: 179,
          name: "B",
          email: "b@example.test",
          template_id: "t",
        },
      ],
    });
    expect(loadPlan(file).sends.map((entry) => entry.email)).toEqual([
      "a@example.test",
    ]);
  });

  it("skips an entry with no address or no template rather than composing half of one", () => {
    const file = planFile({
      direct_matching: [
        { name: "No address", template_id: "t", needs: [] },
        { name: "No template", email: "x@example.test", needs: [] },
      ],
    });
    expect(loadPlan(file).sends).toEqual([]);
  });
});
