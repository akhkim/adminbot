import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import { EMU_PER_INCH, type SlidesPresentation } from "../../contracts/google-slides.js";
import {
  findSlideByTitle,
  flattenSlide,
  measureWorkingGroupsSlide,
  type MeasuredBox,
} from "./face-layout-measure.js";
import { appendSlots, planWorkingGroupsSlide, type GroupPlan } from "./face-layout-plan.js";
import { buildFaceRequests } from "./face-layout-requests.js";
import { renderWorkingGroupsPlanSvg } from "./face-layout-svg.js";
import {
  applyRequests,
  image,
  legacyFace,
  SLIDE_H,
  SLIDE_ID,
  SLIDE_W,
  syntheticDeck,
  syntheticMember,
  taggedFace,
  type FixtureFace,
} from "./face-layout.test-helpers.js";
import {
  faceObjectId,
  faceOwnerTag,
  WORKING_GROUP_BOXES,
  workingGroupMembers,
} from "./working-groups.js";

const inch = (value: number) => Math.round(value * EMU_PER_INCH);
const POWER = WORKING_GROUP_BOXES.find((box) => box.key === "power")!;

function team(groupKey: string, count: number, from = 0): AdminBotLabMember[] {
  return Array.from({ length: count }, (_, index) =>
    syntheticMember(`${groupKey}${String(from + index).padStart(2, "0")}`, groupKey),
  );
}

function plan(deck: SlidesPresentation, members: readonly AdminBotLabMember[], allowRemovals = false) {
  const found = findSlideByTitle(deck, "Scaling to 50-100 Technical Members");
  if (!found.ok) {
    throw new Error(found.reason);
  }
  const measured = measureWorkingGroupsSlide(found.slide, WORKING_GROUP_BOXES);
  const result = planWorkingGroupsSlide({ slideObjectId: found.slide.objectId, measured, members, allowRemovals });
  return { measured, plan: result, payload: buildFaceRequests(result, deck.presentationId) };
}

function group(result: { plan: { groups: GroupPlan[] } }, key: string): GroupPlan {
  return result.plan.groups.find((entry) => entry.key === key)!;
}

function slideIds(deck: SlidesPresentation): Map<string, { x?: number; y?: number }> {
  return new Map(
    deck.slides![1]!.pageElements!.map((element) => [
      element.objectId,
      { x: element.transform?.translateX, y: element.transform?.translateY },
    ]),
  );
}

// Shaped like the real slide: every box holding between five and twenty-odd faces, all placed by
// hand and labelled only by name in their alt text, and a Power Concentration box full of people
// the roster can name only through the box's keywords.
const COUNTS = { interp: 20, adversarial: 5, multiagent: 18, control: 5, causality: 12 } as const;
function realisticDeck() {
  const members = Object.entries(COUNTS).flatMap(([key, count]) => team(key, count));
  const faces: Record<string, FixtureFace[]> = {};
  for (const [key, count] of Object.entries(COUNTS)) {
    faces[key] = team(key, count).map((member, index) => legacyFace(member, index));
  }
  // Twelve hand-placed faces nobody can be tied to.
  faces.power = Array.from({ length: 12 }, (_, index) => ({ objectId: `g_power_${index}` }));
  return { deck: syntheticDeck(faces), members };
}

describe("measureWorkingGroupsSlide", () => {
  it("finds the slide by its heading however the dash is typed", () => {
    const { deck } = realisticDeck();
    expect(findSlideByTitle(deck, "scaling to 50–100 technical members")).toMatchObject({
      ok: true,
      slide: { objectId: SLIDE_ID },
    });
    expect(findSlideByTitle(deck, "Some other slide")).toMatchObject({ ok: false });
  });

  it("reads each box's face size, spacing, wrap, ring and paint order", () => {
    const { deck } = realisticDeck();
    const measured = measureWorkingGroupsSlide(deck.slides![1]!, WORKING_GROUP_BOXES);
    expect(measured.every((box) => box.found)).toBe(true);
    const interp = measured.find((box) => box.box.key === "interp") as MeasuredBox;
    expect(interp.faces).toHaveLength(20);
    expect(interp.metrics.faceW).toBeCloseTo(inch(0.55), -2);
    expect(interp.metrics.gapX).toBeCloseTo(inch(0.1), -2);
    expect(interp.metrics.gapY).toBeCloseTo(inch(0.1), -2);
    expect(interp.metrics).toMatchObject({
      columns: 6,
      rows: 4,
      align: "left",
      zOrder: "above_box",
      ring: { red: 1, green: 1, blue: 1, weight: 1.5 * 12_700 },
      measured: true,
    });
    expect((measured.find((box) => box.box.key === "power") as MeasuredBox).faces).toHaveLength(12);
  });

  it("composes group transforms", () => {
    const deck = syntheticDeck({});
    deck.slides![1]!.pageElements!.push({
      objectId: "g_group",
      transform: { scaleX: 1, scaleY: 1, translateX: inch(1), translateY: inch(1.5), unit: "EMU" },
      elementGroup: { children: [image("g_child", inch(0.1), 0, inch(0.55))] },
    });
    const child = flattenSlide(deck.slides![1]!).find((entry) => entry.element.objectId === "g_child")!;
    expect(child.rect.x).toBeCloseTo(inch(1.1), -1);
    expect(child.rect.y).toBeCloseTo(inch(1.5), -1);
    expect(child.grouped).toBe(true);
  });

  it("ignores pictures that are not face-shaped, and reports a box it cannot find", () => {
    const deck = syntheticDeck({});
    const banner = image("g_banner", inch(0.5), inch(1.6), inch(0.55));
    banner.transform.scaleX = (2 * inch(0.55)) / inch(2);
    deck.slides![1]!.pageElements!.push(banner);
    deck.slides![1]!.pageElements = deck.slides![1]!.pageElements!.filter(
      (element) => element.objectId !== "g_heading_causality",
    );
    const measured = measureWorkingGroupsSlide(deck.slides![1]!, WORKING_GROUP_BOXES);
    expect((measured[0] as MeasuredBox).faces).toHaveLength(0);
    expect(measured.find((box) => box.box.key === "causality")).toMatchObject({ found: false });
  });
});

describe("working-group membership", () => {
  it("puts people in Power Concentration by whole-phrase keywords", () => {
    const yes = [
      syntheticMember("p1", "none", { research_topics: ["Extreme Power Concentration"] }),
      syntheticMember("p2", "none", { research_topics: ["AI governance"] }),
      syntheticMember("p3", "none", { research_topics: [], projects: ["AI and Democracy"] } as Partial<AdminBotLabMember>),
      syntheticMember("p4", "none", { research_topics: ["concentration-of-power risks"] }),
    ];
    const no = [
      syntheticMember("n1", "none", { research_topics: ["ML powered causality"] }),
      syntheticMember("n2", "none", { research_topics: ["Governance of open-source AI"] }),
      syntheticMember("n3", "none", { research_topics: ["Power analysis"] }),
    ];
    expect(workingGroupMembers([...yes, ...no], POWER).map((member) => member.id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
  });
});

describe("appendSlots", () => {
  const metrics = {
    faceW: 100,
    faceH: 100,
    gapX: 10,
    gapY: 10,
    columns: 3,
  } as Parameters<typeof appendSlots>[2];
  const content = { x: 0, y: 0, w: 1000, h: 330 };
  const at = (x: number, y: number) => ({ x, y, w: 100, h: 100 });

  it("continues after the last face and wraps where the rows wrap", () => {
    const slots = appendSlots(3, content, metrics, [at(20, 0), at(130, 0), at(240, 0), at(20, 110)]);
    expect(slots).toEqual([at(130, 110), at(240, 110), at(20, 220)]);
  });

  it("returns null rather than overflow the box", () => {
    expect(appendSlots(6, content, metrics, [at(20, 0), at(130, 0), at(240, 0), at(20, 110)])).toBeNull();
  });

  it("does not let a face outside the box anchor the grid, and never covers an image", () => {
    const stray = { x: 2000, y: 0, w: 100, h: 100 };
    // Hangs into the box from above: not in any row, but a slot under it would hide part of it.
    const overhang = { x: 250, y: -60, w: 100, h: 100 };
    expect(appendSlots(1, content, metrics, [at(20, 0), at(130, 0), overhang])).toEqual([at(20, 110)]);
  });
});

describe("planWorkingGroupsSlide", () => {
  it("appends a new member after the last face, at the measured size and spacing", () => {
    const { deck, members } = realisticDeck();
    const result = plan(deck, [...members, syntheticMember("interp99", "interp", { name: "Zed New" })]);
    const interp = group(result, "interp");
    expect(interp).toMatchObject({ status: "update", added: ["Zed New"], noRoom: [] });
    // Twenty faces are rows of 6, 6, 6 and 2; the new one is the third in the last row.
    const lastRow = interp.faces.filter((face) => face.action === "keep").slice(18);
    const created = interp.faces.find((face) => face.action === "create")!;
    expect(created.rect.y).toBe(Math.round(lastRow[0]!.rect.y));
    expect(created.rect.x - (lastRow[1]!.rect.x + lastRow[1]!.rect.w)).toBeCloseTo(inch(0.1), -2);
    expect(created.rect.w).toBeCloseTo(inch(0.55), -2);
    expect(result.payload.requests).toEqual([
      {
        createImage: expect.objectContaining({
          objectId: faceObjectId("interp", "interp99"),
          url: "https://example.com/avatars/interp99.png",
        }),
      },
      {
        updatePageElementAltText: {
          objectId: faceObjectId("interp", "interp99"),
          title: "Zed New",
          description: faceOwnerTag("interp99"),
        },
      },
    ]);
    expect(result.payload.faces).toEqual([
      {
        object_id: faceObjectId("interp", "interp99"),
        member_id: "interp99",
        avatar_url: "https://example.com/avatars/interp99.png",
        ring: { red: 1, green: 1, blue: 1, width_ratio: expect.closeTo(1.5 / 72 / 0.55, 2) },
      },
    ]);
    for (const other of ["adversarial", "multiagent", "control", "causality"]) {
      expect(group(result, other).status).toBe("unchanged");
    }
  });

  it("wraps onto a new row when the last row is full", () => {
    const members = team("adversarial", 6);
    const deck = syntheticDeck({ adversarial: members.map((member, index) => legacyFace(member, index)) });
    const result = plan(deck, [...members, ...team("adversarial", 1, 6)]);
    const adversarial = group(result, "adversarial");
    const first = adversarial.faces[0]!;
    const created = adversarial.faces.find((face) => face.action === "create")!;
    expect(created.rect.x).toBe(Math.round(first.rect.x));
    expect(created.rect.y - (first.rect.y + first.rect.h)).toBeCloseTo(inch(0.1), -2);
  });

  it("reports a full box and adds nobody to it instead of overflowing", () => {
    const { deck, members } = realisticDeck();
    // Twenty faces plus five more is past the box's twenty-four.
    const joiners = team("interp", 5, 20);
    const result = plan(deck, [...members, ...joiners]);
    const interp = group(result, "interp");
    expect(interp.status).toBe("full");
    expect(interp.added).toEqual([]);
    expect(interp.noRoom).toEqual(joiners.map((member) => member.name));
    expect(interp.reason).toMatch(/do not fit/u);
    expect(result.payload.requests).toEqual([]);
    expect(result.payload.groups.find((entry) => entry.group === "interp")).toMatchObject({
      status: "full",
      no_room: joiners.map((member) => member.name),
    });
    // Four still fit.
    expect(group(plan(deck, [...members, ...joiners.slice(0, 4)]), "interp").added).toHaveLength(4);
  });

  it("never moves or deletes an existing image, even for people who left", () => {
    const { deck, members } = realisticDeck();
    const roster = members
      .filter((member) => member.id !== "control02")
      .map((member): AdminBotLabMember => (member.id === "interp00" ? { ...member, status: "alumni" as AdminBotLabMember["status"] } : member));
    const result = plan(deck, [...roster, syntheticMember("causality99", "causality")], true);
    expect(result.payload.requests.filter((request) => !("createImage" in request) && !("updatePageElementAltText" in request))).toEqual([]);
    for (const entry of result.plan.groups) {
      expect(entry.removed).toEqual([]);
    }
    const before = slideIds(deck);
    const after = slideIds(applyRequests(deck, result.payload.requests));
    for (const [objectId, position] of before) {
      expect(after.get(objectId)).toEqual(position);
    }
  });

  it("does not add somebody already shown by a hand-placed face, matched by name or email", () => {
    const members = team("control", 2);
    const emailed = syntheticMember("control09", "control", { email: "nine@example.com" });
    const deck = syntheticDeck({
      control: [
        legacyFace(members[0]!, 0),
        { objectId: "g_photo_x", description: "  MEMBER control01 " },
        { objectId: "g_photo_y", description: "nine@example.com" },
      ],
    });
    const result = plan(deck, [...members, emailed]);
    expect(group(result, "control")).toMatchObject({ status: "unchanged", added: [], unidentified: [] });
  });

  it("only removes its own tagged faces, and only with removals switched on", () => {
    const members = team("causality", 3);
    const leaver = syntheticMember("causality07", "causality");
    const deck = syntheticDeck({
      causality: [
        ...members.map((member) => taggedFace("causality", member)),
        // Tagged through alt text, as a face this sync placed and somebody then copied.
        { objectId: "g_copied", description: faceOwnerTag(leaver.id) },
        // A hand-placed face of the same person: tied to them, but never ours to touch.
        { objectId: "g_hand", description: leaver.name },
      ],
    });
    const roster = [...members, { ...leaver, research_topics: ["Post-training"] }];
    const off = plan(deck, roster);
    expect(group(off, "causality")).toMatchObject({ status: "unchanged", removed: [] });
    expect(group(off, "causality").wouldRemove.map((face) => face.objectId)).toEqual(["g_copied"]);
    expect(off.payload.requests).toEqual([]);
    expect(off.payload.groups.find((entry) => entry.group === "causality")?.would_remove).toEqual([leaver.name]);

    const on = plan(deck, roster, true);
    expect(on.payload.requests).toEqual([{ deleteObject: { objectId: "g_copied" } }]);
    expect(on.payload.expected.map((entry) => entry.object_id)).toEqual(["g_copied"]);
    expect(JSON.stringify(on.payload)).not.toContain("g_hand");
  });

  it("re-checks ownership in the request builder, not only in the planner", () => {
    const { deck, members } = realisticDeck();
    const result = plan(deck, members, true);
    const tampered = {
      ...result.plan,
      groups: result.plan.groups.map((entry) =>
        entry.key === "power"
          ? {
              ...entry,
              status: "update" as const,
              removed: [{ objectId: "g_power_0", memberId: null, name: "x", rect: entry.box! }],
            }
          : entry,
      ),
    };
    expect(() => buildFaceRequests(tampered, "deck")).toThrow(/not a face this sync placed/u);
  });

  it("counts an unidentified image as taken room and never touches it", () => {
    const { deck, members } = realisticDeck();
    const power = team("power", 2).map((member) => ({ ...member, research_topics: ["AI governance"] }));
    const result = plan(deck, [...members, ...power]);
    const box = group(result, "power");
    expect(box.status).toBe("update");
    expect(box.unidentified).toHaveLength(12);
    expect(box.added).toEqual(power.map((member) => member.name));
    const created = box.faces.filter((face) => face.action === "create");
    // Twelve faces are two full rows; the new ones open the third.
    expect(created[0]!.rect.x).toBe(Math.round(box.faces[0]!.rect.x));
    expect(JSON.stringify(result.payload.requests)).not.toContain("g_power_");
  });

  it("ignores a stray face off the slide when appending, but still dedupes against it", () => {
    const members = team("causality", 12);
    const late = syntheticMember("causality12", "causality", { name: "Late Joiner" });
    const deck = syntheticDeck({
      causality: [
        ...members.map((member, index) => legacyFace(member, index)),
        // Off the right edge of the slide, beside the box -- left over from a past edit.
        { objectId: "g_stray", description: late.name, at: { x: SLIDE_W + inch(0.1), y: inch(4.6) } },
      ],
    });
    const result = plan(deck, [...members, late, syntheticMember("causality13", "causality")]);
    const causality = group(result, "causality");
    expect(causality.added).toEqual(["Member causality13"]);
    const created = causality.faces.find((face) => face.action === "create")!;
    expect(created.rect.x).toBe(Math.round(causality.faces[0]!.rect.x));
    expect(created.rect.x + created.rect.w).toBeLessThan(SLIDE_W);
  });

  it("skips members without a photo and lists them", () => {
    const { deck, members } = realisticDeck();
    const result = plan(deck, [
      ...members,
      syntheticMember("adversarial77", "adversarial", { name: "No Photo", avatar_url: undefined }),
    ]);
    expect(group(result, "adversarial")).toMatchObject({ status: "unchanged", skippedNoPhoto: ["No Photo"] });
    expect(result.payload.requests).toEqual([]);
  });

  it("starts an empty box under its heading", () => {
    const result = plan(syntheticDeck({}), team("multiagent", 5));
    const multiagent = group(result, "multiagent");
    expect(multiagent.status).toBe("update");
    expect(multiagent.faces.every((face) => face.rect.w === inch(0.55))).toBe(true);
    expect(multiagent.faces[0]!.rect.y).toBe(multiagent.content!.y);
  });

  it("is idempotent: applying the plan and planning again changes nothing", () => {
    const { deck, members } = realisticDeck();
    const roster = [...members, ...team("interp", 3, 20), ...team("causality", 2, 12)];
    const first = plan(deck, roster);
    expect(first.payload.requests).toHaveLength(10);
    const after = applyRequests(deck, first.payload.requests);
    const second = plan(after, roster);
    expect(second.plan.changed).toBe(false);
    expect(second.payload.requests).toEqual([]);
    expect(plan(deck, members).payload.requests).toEqual([]);
  });
});

describe("renderWorkingGroupsPlanSvg", () => {
  it("draws round faces before and after, and names who is added, without any photo URL", () => {
    const { deck, members } = realisticDeck();
    const result = plan(deck, [...members, syntheticMember("interp99", "interp", { name: "Zed New" })]);
    const svg = renderWorkingGroupsPlanSvg(result.plan, { width: SLIDE_W, height: SLIDE_H });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Before");
    expect(svg).toContain("Interpretability");
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("example.com");
    expect(svg).toContain("<title>Zed New</title>");
  });

  it("shows images nobody is tied to, and marks a full box with how many did not fit", () => {
    const { deck, members } = realisticDeck();
    const joiners = Array.from({ length: 5 }, (_, index) => syntheticMember(`interp9${index}`, "interp"));
    const result = plan(deck, [...members, ...joiners]);
    const svg = renderWorkingGroupsPlanSvg(result.plan, { width: SLIDE_W, height: SLIDE_H });
    // The twelve untagged Power Concentration faces, in both panels.
    expect(svg.match(/<title>\?<\/title>/gu)).toHaveLength(24);
    expect(svg).toContain(">+5</text>");
  });
});
