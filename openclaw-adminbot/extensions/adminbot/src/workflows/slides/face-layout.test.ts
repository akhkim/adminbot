import { describe, expect, it } from "vitest";
import type { AdminBotLabMember } from "../../contracts/actions.js";
import { EMU_PER_INCH, type SlidesPresentation } from "../../contracts/google-slides.js";
import {
  findSlideByTitle,
  flattenSlide,
  measureWorkingGroupsSlide,
  type MeasuredBox,
} from "./face-layout-measure.js";
import { MIN_FACE_EMU, planWorkingGroupsSlide, type GroupPlan } from "./face-layout-plan.js";
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
import { faceObjectId, WORKING_GROUP_BOXES } from "./working-groups.js";

const inch = (value: number) => Math.round(value * EMU_PER_INCH);

function team(groupKey: string, count: number, from = 0): AdminBotLabMember[] {
  return Array.from({ length: count }, (_, index) =>
    syntheticMember(`${groupKey}${String(from + index).padStart(2, "0")}`, groupKey),
  );
}

function plan(deck: SlidesPresentation, members: readonly AdminBotLabMember[]) {
  const found = findSlideByTitle(deck, "Scaling to 50-100 Technical Members");
  if (!found.ok) {
    throw new Error(found.reason);
  }
  const measured = measureWorkingGroupsSlide(found.slide, WORKING_GROUP_BOXES);
  const result = planWorkingGroupsSlide({ slideObjectId: found.slide.objectId, measured, members });
  return { measured, plan: result, payload: buildFaceRequests(result, deck.presentationId) };
}

function group(result: { plan: { groups: GroupPlan[] } }, key: string): GroupPlan {
  return result.plan.groups.find((entry) => entry.key === key)!;
}

// A slide shaped like the real one: every theme box holding between five and thirty faces.
function realisticDeck() {
  const counts = { interp: 7, adversarial: 5, multiagent: 8, control: 6, causality: 5 };
  const members = Object.entries(counts).flatMap(([key, count]) => team(key, count));
  const faces: Record<string, FixtureFace[]> = {};
  for (const [key, count] of Object.entries(counts)) {
    faces[key] = team(key, count).map((member, index) => legacyFace(member, index));
  }
  // Power Concentration is hand-maintained; its faces are nobody the roster can name.
  faces.power = Array.from({ length: 6 }, (_, index) => ({ objectId: `g_power_${index}` }));
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

  it("reads each box's face size, spacing, columns, alignment, crop and paint order", () => {
    const { deck } = realisticDeck();
    const measured = measureWorkingGroupsSlide(deck.slides![1]!, WORKING_GROUP_BOXES);
    expect(measured.every((box) => box.found)).toBe(true);
    const interp = measured.find((box) => box.box.key === "interp") as MeasuredBox;
    expect(interp.faces).toHaveLength(7);
    expect(interp.metrics.faceW).toBeCloseTo(inch(0.55), -2);
    expect(interp.metrics.gapX).toBeCloseTo(inch(0.1), -2);
    expect(interp.metrics.gapY).toBeCloseTo(inch(0.1), -2);
    expect(interp.metrics).toMatchObject({
      columns: 4,
      rows: 2,
      align: "center",
      zOrder: "above_box",
      crop: { leftOffset: 0.05, rightOffset: 0.05 },
      measured: true,
    });
    expect(interp.overflowing).toBe(false);
    const power = measured.find((box) => box.box.key === "power") as MeasuredBox;
    expect(power.faces).toHaveLength(6);
  });

  it("composes group transforms, and marks grouped faces as not movable", () => {
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

describe("planWorkingGroupsSlide", () => {
  it("adds a new member into the next slot at the measured size", () => {
    const { deck, members } = realisticDeck();
    const result = plan(deck, [...members, syntheticMember("interp99", "interp", { name: "Zed New" })]);
    expect(group(result, "interp")).toMatchObject({ status: "update", added: ["Zed New"] });
    expect(group(result, "interp").target).toMatchObject({ shrunk: false, columns: 4 });
    // Seven faces were 4 + 3 with the short row centred; the eighth fills that row, so its three
    // faces slide sideways to stay centred -- same size, same row, nobody else moves.
    const moves = group(result, "interp").faces.filter((face) => face.action === "move");
    expect(moves).toHaveLength(3);
    for (const face of moves) {
      expect(face.rect.y).toBe(Math.round(face.from!.y));
      expect(face.rect.w).toBe(inch(0.55));
    }
    expect(result.payload.requests).toHaveLength(4);
    const create = result.payload.requests.at(-1)!;
    expect(create).toMatchObject({
      createImage: {
        objectId: faceObjectId("interp", "interp99"),
        url: "https://example.com/avatars/interp99.png",
        elementProperties: {
          pageObjectId: SLIDE_ID,
          size: { width: { magnitude: inch(0.55) }, height: { magnitude: inch(0.55) } },
        },
      },
    });
    for (const other of ["adversarial", "multiagent", "control", "causality"]) {
      expect(group(result, other).status).toBe("unchanged");
    }
  });

  it("appends without moving anybody when the last row is full", () => {
    const members = team("adversarial", 4);
    const deck = syntheticDeck({
      adversarial: members.map((member, index) => legacyFace(member, index)),
    });
    const result = plan(deck, [...members, ...team("adversarial", 1, 4)]);
    expect(result.payload.requests).toHaveLength(1);
    expect("createImage" in result.payload.requests[0]!).toBe(true);
  });

  it("shrinks every face in an overflowing group uniformly and centres the grid", () => {
    const { deck, members } = realisticDeck();
    const result = plan(deck, [...members, ...team("interp", 23, 7)]);
    const interp = group(result, "interp");
    expect(interp.status).toBe("update");
    expect(interp.target?.shrunk).toBe(true);
    expect(interp.faces).toHaveLength(30);
    const sizes = new Set(interp.faces.map((face) => `${face.rect.w}x${face.rect.h}`));
    expect(sizes.size).toBe(1);
    expect(interp.faces[0]!.rect.w).toBeLessThan(inch(0.55));
    expect(interp.faces[0]!.rect.w).toBeGreaterThanOrEqual(MIN_FACE_EMU);
    const content = interp.content!;
    for (const face of interp.faces) {
      expect(face.rect.x).toBeGreaterThanOrEqual(content.x);
      expect(face.rect.y).toBeGreaterThanOrEqual(content.y);
      expect(face.rect.x + face.rect.w).toBeLessThanOrEqual(content.x + content.w + 1);
      expect(face.rect.y + face.rect.h).toBeLessThanOrEqual(content.y + content.h + 1);
    }
    // Centred: the first full row leaves the same margin on both sides, and the same gap between
    // every pair of neighbours.
    const firstRow = interp.faces.filter((face) => face.rect.y === interp.faces[0]!.rect.y);
    const left = firstRow[0]!.rect.x - content.x;
    const right = content.x + content.w - (firstRow.at(-1)!.rect.x + firstRow.at(-1)!.rect.w);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
    const gaps = firstRow.slice(1).map((face, index) => face.rect.x - firstRow[index]!.rect.x);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    // The existing seven faces are resized in place, never recreated.
    expect(interp.faces.filter((face) => face.action === "move")).toHaveLength(7);
    expect(interp.faces.filter((face) => face.action === "create")).toHaveLength(23);
    // Only this box shrank.
    expect(group(result, "adversarial").status).toBe("unchanged");
  });

  it("pulls faces that already spilled out of their box back in, instead of adding them twice", () => {
    // Fourteen faces at the slide's four-a-row: rows three and four hang below the Multi-Agent
    // box, which is how the real slide looks once a group outgrows it.
    const crew = team("multiagent", 14);
    const deck = syntheticDeck({ multiagent: crew.map((member, index) => legacyFace(member, index)) });
    // A face-sized logo in the title band must not be mistaken for anybody's spilled face.
    deck.slides![1]!.pageElements!.push(image("g_logo", inch(9.2), inch(0.2), inch(0.55)));
    const measured = measureWorkingGroupsSlide(deck.slides![1]!, WORKING_GROUP_BOXES);
    const box = measured.find((entry) => entry.box.key === "multiagent") as MeasuredBox;
    expect(box.faces).toHaveLength(14);
    expect(box.overflowing).toBe(true);
    expect(box.metrics.faceW).toBe(inch(0.55));
    expect(measured.some((entry) => entry.found && entry.faces.some((face) => face.objectId === "g_logo"))).toBe(false);

    const joiner = syntheticMember("multiagent14", "multiagent");
    const result = plan(deck, [...crew, joiner]);
    const multi = group(result, "multiagent");
    expect(multi.status).toBe("update");
    expect(multi.faces).toHaveLength(15);
    expect(multi.faces.filter((face) => face.action === "create")).toHaveLength(1);
    for (const face of multi.faces) {
      expect(face.rect.y + face.rect.h).toBeLessThanOrEqual(multi.content!.y + multi.content!.h + 1);
    }
    const after = applyRequests(deck, result.payload.requests);
    expect(plan(after, [...crew, joiner]).payload.requests).toEqual([]);
  });

  it("refuses to shrink faces into confetti", () => {
    const { deck, members } = realisticDeck();
    const result = plan(deck, [...members, ...team("interp", 200, 7)]);
    expect(group(result, "interp")).toMatchObject({ status: "blocked" });
    expect(group(result, "interp").reason).toMatch(/enlarge or split/u);
    expect(result.payload.requests).toEqual([]);
  });

  it("removes members who left the group and closes the gap", () => {
    const { deck, members } = realisticDeck();
    const leaver = members.find((member) => member.id === "interp00")!;
    const alumni = members.find((member) => member.id === "interp03")!;
    const roster = members.map((member) =>
      member === leaver
        ? { ...member, research_topics: ["Post-training"] }
        : member === alumni
          ? { ...member, status: "alumni" }
          : member,
    );
    const result = plan(deck, roster);
    const interp = group(result, "interp");
    expect(interp.removed.map((face) => face.memberId).toSorted()).toEqual(["interp00", "interp03"]);
    expect(interp.faces).toHaveLength(5);
    const deletes = result.payload.requests.filter((request) => "deleteObject" in request);
    expect(deletes).toHaveLength(2);
    // Deletes go first, so a face leaving and one arriving never overlap mid-batch.
    expect("deleteObject" in result.payload.requests[0]!).toBe(true);
    expect(result.payload.expected.map((entry) => entry.object_id)).toEqual(
      expect.arrayContaining(deletes.map((request) => ("deleteObject" in request ? request.deleteObject.objectId : ""))),
    );
  });

  it("is idempotent: applying the plan and planning again changes nothing", () => {
    const { deck, members } = realisticDeck();
    const roster = [
      ...members.filter((member) => member.id !== "control02"),
      ...team("interp", 23, 7),
      ...team("causality", 2, 5),
    ];
    const first = plan(deck, roster);
    expect(first.payload.requests.length).toBeGreaterThan(0);
    const after = applyRequests(deck, first.payload.requests);
    const second = plan(after, roster);
    expect(second.plan.changed).toBe(false);
    expect(second.payload.requests).toEqual([]);
    expect(group(second, "interp").faces).toHaveLength(30);
    // And the unchanged slide plans no requests from the start.
    expect(plan(deck, members).payload.requests).toEqual([]);
  });

  it("never touches an image it cannot tie to a member, and blocks its box instead", () => {
    const { deck, members } = realisticDeck();
    const slide = deck.slides![1]!;
    const interpFace = slide.pageElements!.find((element) => element.objectId.includes("interp00"))!;
    delete interpFace.description;
    const result = plan(deck, [...members, syntheticMember("interp99", "interp")]);
    expect(group(result, "interp")).toMatchObject({ status: "blocked" });
    expect(group(result, "interp").reason).toMatch(/not tied to a member/u);
    expect(group(result, "interp").unidentified).toEqual([interpFace.objectId]);
    expect(JSON.stringify(result.payload.requests)).not.toContain(interpFace.objectId);
    // The hand-maintained Power Concentration faces are measured and left alone.
    expect(group(result, "power")).toMatchObject({ status: "untouched" });
    expect(JSON.stringify(result.payload.requests)).not.toContain("g_power_");
  });

  it("re-checks identification in the request builder, not only in the planner", () => {
    const { deck, members } = realisticDeck();
    const result = plan(
      deck,
      members.map((member) =>
        member.id === "control00" ? { ...member, research_topics: ["Post-training"] } : member,
      ),
    );
    expect(group(result, "control").status).toBe("update");
    const tampered = {
      ...result.plan,
      groups: result.plan.groups.map((entry) =>
        entry.key === "control"
          ? { ...entry, removed: [...entry.removed, { objectId: "g_power_0", memberId: null, name: "x", rect: entry.box! }] }
          : entry,
      ),
    };
    expect(() => buildFaceRequests(tampered, "deck")).toThrow(/not an identified member face/u);
  });

  it("skips members without a photo and lists them", () => {
    const { deck, members } = realisticDeck();
    const result = plan(deck, [
      ...members,
      syntheticMember("adversarial77", "adversarial", { name: "No Photo", avatar_url: undefined }),
    ]);
    expect(group(result, "adversarial")).toMatchObject({
      status: "unchanged",
      skippedNoPhoto: ["No Photo"],
    });
    expect(result.payload.requests).toEqual([]);
  });

  it("knows its own faces by id, removes those of people who left the roster, and keeps a duplicate out", () => {
    const members = team("causality", 3);
    const deck = syntheticDeck({
      causality: [
        ...members.map((member) => taggedFace("causality", member)),
        taggedFace("causality", syntheticMember("ghost", "causality")),
        legacyFace(members[0]!, 9),
      ],
    });
    const result = plan(deck, members);
    const causality = group(result, "causality");
    expect(causality.removed.map((face) => face.name).toSorted()).toEqual([
      "Member causality00",
      "former member",
    ]);
    expect(causality.faces.map((face) => face.memberId)).toEqual(members.map((member) => member.id));
  });

  it("fills an empty box with default-size faces starting under its heading", () => {
    const deck = syntheticDeck({});
    const result = plan(deck, team("multiagent", 5));
    const multiagent = group(result, "multiagent");
    expect(multiagent.status).toBe("update");
    expect(multiagent.faces.every((face) => face.rect.w === inch(0.55))).toBe(true);
    expect(multiagent.faces[0]!.rect.y).toBe(multiagent.content!.y);
  });

  it("does not move a grouped face; it explains why instead", () => {
    const members = team("control", 2);
    const deck = syntheticDeck({ control: [legacyFace(members[0]!, 0)] });
    const slide = deck.slides![1]!;
    const face = slide.pageElements!.find((element) => element.objectId.startsWith("g_photo_0"))!;
    slide.pageElements = [
      ...slide.pageElements!.filter((element) => element !== face),
      { objectId: "g_wrap", elementGroup: { children: [face] } },
    ];
    // An overflow forces a reflow, which the grouped face cannot take part in.
    const result = plan(deck, [...members, ...team("control", 40, 2)]);
    expect(group(result, "control")).toMatchObject({ status: "blocked" });
    expect(group(result, "control").reason).toMatch(/grouped or rotated/u);
  });
});

describe("renderWorkingGroupsPlanSvg", () => {
  it("draws before and after without fetching anybody's photo", () => {
    const { deck, members } = realisticDeck();
    const result = plan(deck, [...members, ...team("interp", 10, 7)]);
    const svg = renderWorkingGroupsPlanSvg(result.plan, { width: SLIDE_W, height: SLIDE_H });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Before");
    expect(svg).toContain("Interpretability");
    expect(svg).not.toContain("example.com");
  });
});
