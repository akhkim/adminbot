/* @vitest-environment jsdom */
// The pre-registration dialog's selection state.
//
// The bug this pins: two id spaces write `artifacts.venue_targets` -- this dialog writes
// deadline-board ids (`iclr2027_paper`), the Add a project form writes venue-catalog ids
// (`ICLR`) with the year in the label -- and the venue cards test the selection by string.
// A paper already aimed at ICLR through the other form seeded a key no card recognised, so its
// card rendered unselected while the footer still counted it: the button offered to
// "Pre-register for 2 venues" when exactly one was visibly picked.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminBotPaperRecord, AdminBotPaperSaveInput } from "./controllers/admin.ts";
import { openPreRegistrationDialog } from "./pre-registration.ts";
import { readVenueTargets } from "./venue-targets.ts";

// jsdom implements neither showModal nor close on <dialog>; the same stub command-palette.test.ts
// installs, so the dialog under test can actually open.
const showModalDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
const closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});

afterEach(() => {
  document.body.replaceChildren();
  for (const [name, descriptor] of [
    ["showModal", showModalDescriptor],
    ["close", closeDescriptor],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    } else {
      delete (HTMLDialogElement.prototype as Record<string, unknown>)[name];
    }
  }
});

function paper(targets: unknown[] = []): AdminBotPaperRecord {
  return {
    id: "test",
    title: "TEST",
    authors: ["Andrew Kim"],
    current_step: "brainstorming_docs",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...(targets.length
      ? { artifacts: { venue_targets: JSON.stringify(targets) } }
      : { artifacts: {} }),
  } as unknown as AdminBotPaperRecord;
}

function open(record: AdminBotPaperRecord) {
  const saved: AdminBotPaperSaveInput[] = [];
  openPreRegistrationDialog({
    papers: [record],
    onSavePaper: (input) => saved.push(input),
    onDone: () => {},
  });
  const dialog = document.querySelector("dialog.prereg");
  if (!dialog) {
    throw new Error("dialog did not open");
  }
  return { dialog, saved };
}

const saveLabel = (dialog: Element) =>
  dialog.querySelector('[data-act="save"]')?.textContent?.replace(/\s+/gu, " ").trim() ?? "";

describe("the pre-registration dialog", () => {
  it("counts one venue when the paper is aimed at one, whichever form wrote it", () => {
    // Exactly the shape from Add a project: catalog id, year in the label.
    const { dialog } = open(paper([{ venue_id: "ICLR", label: "ICLR 2027", confidence: 50 }]));
    expect(saveLabel(dialog)).toBe("Pre-register for 1 venue");
  });

  it("shows that venue's card as picked, at the odds already on file", () => {
    const { dialog } = open(paper([{ venue_id: "ICLR", label: "ICLR 2027", confidence: 50 }]));
    const card = dialog.querySelector('[data-venue="iclr2027_paper"]')?.closest(".prereg__venue");
    expect(card?.className).toContain("is-on");
    const chosen = card?.querySelector(".prereg__odd.is-on");
    expect(chosen?.textContent?.trim()).toBe("50%");
  });

  it("counts two only when the paper really is aimed at two", () => {
    const { dialog } = open(
      paper([
        { venue_id: "ICLR", label: "ICLR 2027", confidence: 50 },
        { venue_id: "arr_2026_october", label: "ARR October", confidence: 80 },
      ]),
    );
    expect(saveLabel(dialog)).toBe("Pre-register for 2 venues");
  });

  it("keeps a venue the dialog does not list rather than erasing it on save", () => {
    // Saving replaces the whole target list, so a venue with no card here still has to survive.
    const { dialog, saved } = open(
      paper([{ venue_id: "NeurIPS-main", label: "NeurIPS 2027", confidence: 80 }]),
    );
    (dialog.querySelector('[data-act="save"]') as HTMLButtonElement | null)?.click();
    const written = readVenueTargets({
      artifacts: { venue_targets: saved[0]?.venueTargets },
    } as unknown as AdminBotPaperRecord);
    expect(written).toHaveLength(1);
    expect(written[0]?.venue_id).toBe("NeurIPS-main");
    // And it keeps the name it arrived with, not its raw id.
    expect(written[0]?.label).toBe("NeurIPS 2027");
  });

  it("says to pick one when the paper is aimed nowhere yet", () => {
    const { dialog } = open(paper());
    expect(saveLabel(dialog)).toBe("Pick a venue");
    expect((dialog.querySelector('[data-act="save"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
