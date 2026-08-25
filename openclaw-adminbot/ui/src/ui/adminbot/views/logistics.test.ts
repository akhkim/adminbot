import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AccessRole } from "../access.ts";
import {
  createFactRow,
  createMeetingRow,
  createSchoolRow,
  type LetterFact,
  type MeetingRequestRow,
  type RecommendationSchool,
} from "../data/logistics-draft.ts";
import type { LogisticsRequest, LogisticsRequestStatus } from "../data/logistics-requests.ts";
import {
  renderAdminBotLogistics,
  type LogisticsMode,
  type LogisticsTemplate,
  type SubmitBlock,
} from "./logistics.ts";

type DrawOptions = {
  /** False draws the Google Form signpost instead of the correction form. */
  signatureEditing?: boolean;
  role?: AccessRole;
  mode?: LogisticsMode;
  requests?: LogisticsRequest[];
  requestsLoading?: boolean;
  requestsError?: string | null;
  showSettled?: boolean;
  signingId?: string | null;
  signedNote?: string;
  openRequest?: LogisticsRequest | null;
  openLoading?: boolean;
  viewerMemberId?: string | null;
  statusNote?: string;
  submitting?: boolean;
  submitError?: string | null;
  submitted?: boolean;
  submitBlocked?: SubmitBlock | null;
  hasContent?: boolean;
  editing?: boolean;
  template?: LogisticsTemplate;
  signatureFiles?: File[];
  attachments?: File[];
  description?: string;
  saving?: boolean;
  savedAt?: number | null;
  saveError?: string | null;
  schools?: RecommendationSchool[];
  facts?: LetterFact[];
  meetings?: MeetingRequestRow[];
  meetingSaving?: boolean;
  meetingSavedAt?: number | null;
  meetingSaveError?: string | null;
  cvOverleafUrl?: string;
  driveFolderUrl?: string;
  lettersSaving?: boolean;
  lettersSavedAt?: number | null;
  lettersSaveError?: string | null;
};

type Drawn = {
  container: HTMLElement;
  modeChanges: LogisticsMode[];
  opened: (string | null)[];
  withdrawn: string[];
  edited: string[];
  settledToggles: boolean[];
  signedNoteChanges: string[];
  signedUploads: { id: string; files: File[] }[];
  cancelledEdits: number;
  answers: { id: string; status: LogisticsRequestStatus; note: string }[];
  noteChanges: string[];
  submits: number;
  lettersSubmits: number;
  meetingSubmits: number;
  discards: number;
  signatureChanges: File[][];
  attachmentChanges: File[][];
  descriptionChanges: string[];
  schoolChanges: RecommendationSchool[][];
  factChanges: LetterFact[][];
  meetingChanges: MeetingRequestRow[][];
  myProjectsOpened: number;
  cvOverleafChanges: string[];
  driveFolderChanges: string[];
  saves: number;
  lettersSaves: number;
  meetingSaves: number;
};

// The submit half of every form's props, which the three share: only one form is on screen at a
// time, so a test that presses Submit is always pressing this one.
function submitProps(options: DrawOptions, onSubmit: () => void) {
  return {
    onSubmit,
    submitBlocked: options.submitBlocked ?? null,
    submitting: options.submitting ?? false,
    submitError: options.submitError ?? null,
    submitted: options.submitted ?? false,
    hasContent: options.hasContent ?? true,
    editing: options.editing ?? false,
    onCancelEdit: () => {
      cancelEditCount += 1;
    },
    onDiscard: () => {
      discardCount += 1;
    },
  };
}

// Counted outside `draw` because submitProps is called three times per render and the counter has
// to survive all three.
let discardCount = 0;
let cancelEditCount = 0;

function draw(options: DrawOptions = {}): Drawn {
  discardCount = 0;
  cancelEditCount = 0;
  const signatureChanges: File[][] = [];
  const attachmentChanges: File[][] = [];
  const descriptionChanges: string[] = [];
  const schoolChanges: RecommendationSchool[][] = [];
  const factChanges: LetterFact[][] = [];
  const meetingChanges: MeetingRequestRow[][] = [];
  const cvOverleafChanges: string[] = [];
  const driveFolderChanges: string[] = [];
  const modeChanges: LogisticsMode[] = [];
  const opened: (string | null)[] = [];
  const withdrawn: string[] = [];
  const edited: string[] = [];
  const settledToggles: boolean[] = [];
  const signedNoteChanges: string[] = [];
  const signedUploads: { id: string; files: File[] }[] = [];
  const downloads: { id: string; name: string }[] = [];
  const answers: {
    id: string;
    status: LogisticsRequestStatus;
    note: string;
  }[] = [];
  const noteChanges: string[] = [];
  let submits = 0;
  let lettersSubmits = 0;
  let meetingSubmits = 0;
  let saves = 0;
  let lettersSaves = 0;
  let meetingSaves = 0;
  let myProjectsOpened = 0;
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderAdminBotLogistics({
      role: options.role ?? "member",
      mode: options.mode ?? "make",
      onModeChange: (next) => modeChanges.push(next),
      queue: {
        requests: options.requests ?? [],
        loading: options.requestsLoading ?? false,
        error: options.requestsError ?? null,
        showSettled: options.showSettled ?? false,
        onShowSettledChange: (next) => settledToggles.push(next),
        signingId: options.signingId ?? null,
        downloadingId: null,
        onDownload: (id, name) => downloads.push({ id, name }),
        signedNote: options.signedNote ?? "",
        onSignedNoteChange: (next) => signedNoteChanges.push(next),
        onSendSigned: (id, files) => signedUploads.push({ id, files }),
        onOpenRequest: (next) => opened.push(next),
        onSetStatus: (id, status) => answers.push({ id, status, note: "" }),
      },
      requests: {
        requests: options.requests ?? [],
        loading: options.requestsLoading ?? false,
        error: options.requestsError ?? null,
        open: options.openRequest ?? null,
        openLoading: options.openLoading ?? false,
        viewerIsAdmin: (options.role ?? "member") === "admin",
        viewerMemberId: options.viewerMemberId ?? "ada",
        onOpenRequest: (next) => opened.push(next),
        onWithdraw: (id) => withdrawn.push(id),
        onEdit: (id) => edited.push(id),
        onSetStatus: (id, status, note) => answers.push({ id, status, note }),
        statusNote: options.statusNote ?? "",
        onStatusNoteChange: (next) => noteChanges.push(next),
      },
      template: options.template ?? "documentSignature",
      signature: {
        files: options.signatureFiles ?? [],
        onFilesChange: (next) => signatureChanges.push(next),
        description: options.description ?? "",
        onDescriptionChange: (next) => descriptionChanges.push(next),
        attachments: options.attachments ?? [],
        onAttachmentsChange: (next) => attachmentChanges.push(next),
        saving: options.saving ?? false,
        savedAt: options.savedAt ?? null,
        saveError: options.saveError ?? null,
        onSave: () => {
          saves += 1;
        },
        ...submitProps(options, () => {
          submits += 1;
        }),
        // Defaults to the correction path, because that is the only route that still renders the
        // upload form: a new signature request is filed on the Google Form now, and the tab shows
        // a link instead. Tests covering that link pass `signatureEditing: false`.
        editing: options.signatureEditing ?? true,
      },
      meeting: {
        rows: options.meetings ?? [],
        onRowsChange: (next) => meetingChanges.push(next),
        saving: options.meetingSaving ?? false,
        savedAt: options.meetingSavedAt ?? null,
        saveError: options.meetingSaveError ?? null,
        onSave: () => {
          meetingSaves += 1;
        },
        ...submitProps(options, () => {
          meetingSubmits += 1;
        }),
      },
      letters: {
        schools: options.schools ?? [],
        onSchoolsChange: (next) => schoolChanges.push(next),
        facts: options.facts ?? [],
        onFactsChange: (next) => factChanges.push(next),
        onOpenMyProjects: () => {
          myProjectsOpened += 1;
        },
        cvOverleafUrl: options.cvOverleafUrl ?? "",
        onCvOverleafUrlChange: (next) => cvOverleafChanges.push(next),
        driveFolderUrl: options.driveFolderUrl ?? "",
        onDriveFolderUrlChange: (next) => driveFolderChanges.push(next),
        saving: options.lettersSaving ?? false,
        savedAt: options.lettersSavedAt ?? null,
        saveError: options.lettersSaveError ?? null,
        onSave: () => {
          lettersSaves += 1;
        },
        ...submitProps(options, () => {
          lettersSubmits += 1;
        }),
      },
    }),
    container,
  );
  return {
    container,
    modeChanges,
    opened,
    withdrawn,
    edited,
    settledToggles,
    signedNoteChanges,
    signedUploads,
    get cancelledEdits() {
      return cancelEditCount;
    },
    answers,
    noteChanges,
    signatureChanges,
    attachmentChanges,
    descriptionChanges,
    schoolChanges,
    factChanges,
    meetingChanges,
    cvOverleafChanges,
    driveFolderChanges,
    get myProjectsOpened() {
      return myProjectsOpened;
    },
    get submits() {
      return submits;
    },
    get lettersSubmits() {
      return lettersSubmits;
    },
    get meetingSubmits() {
      return meetingSubmits;
    },
    get discards() {
      return discardCount;
    },
    get saves() {
      return saves;
    },
    get lettersSaves() {
      return lettersSaves;
    },
    get meetingSaves() {
      return meetingSaves;
    },
  };
}

function modeButtons(container: HTMLElement): HTMLButtonElement[] {
  const card = container.querySelector<HTMLElement>("[data-testid='logistics-admin']");
  return [...(card?.querySelectorAll<HTMLButtonElement>(".logistics__template") ?? [])];
}

function drawLetters(options: Omit<DrawOptions, "template"> = {}): Drawn {
  return draw({ ...options, template: "recommendationLetters" });
}

function makeFile(name: string, size = 4, lastModified = 1): File {
  const file = new File(["x".repeat(size)], name, {
    type: "application/pdf",
    lastModified,
  });
  // jsdom derives size from the parts, but pin it so the assertions do not depend on that.
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function dropzone(container: HTMLElement, testId: string): HTMLElement {
  const zone = container.querySelector<HTMLElement>(`[data-testid='${testId}']`);
  if (!zone) {
    throw new Error(`dropzone ${testId} missing`);
  }
  return zone;
}

function signatureZone(container: HTMLElement): HTMLElement {
  return dropzone(container, "logistics-signature-drop");
}

function attachmentZone(container: HTMLElement): HTMLElement {
  return dropzone(container, "logistics-attachments-drop");
}

function fireDrop(zone: HTMLElement, files: File[]): void {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  zone.dispatchEvent(event);
}

function describedTextarea(container: HTMLElement): HTMLTextAreaElement {
  const field = container.querySelector<HTMLTextAreaElement>(".logistics-supporting__description");
  if (!field) {
    throw new Error("description field missing");
  }
  return field;
}

describe("renderAdminBotLogistics", () => {
  it("draws only the form the tab asked for, with no picker above it", () => {
    // Choosing between the three is the sidebar's job now (LOGISTICS_TAB_TEMPLATES), so arriving
    // here already means having chosen and a picker would be a second place to choose.
    const { container } = draw();
    expect(container.querySelector("[data-testid='logistics-templates']")).toBeNull();
    expect(container.querySelector("[data-testid='logistics-request']")).not.toBeNull();
  });

  it("puts a file input inside the label so clicking the zone opens the picker", () => {
    const { container } = draw();
    const zone = signatureZone(container);
    // The affordance is the browser's own label->input association, so the input has to be a
    // descendant of the label. Nothing else wires the click.
    expect(zone.tagName).toBe("LABEL");
    const input = zone.querySelector<HTMLInputElement>("input[type='file']");
    expect(input).not.toBeNull();
    expect(input?.multiple).toBe(true);
    expect(input?.accept).toContain("application/pdf");
  });

  it("reports files dropped onto the signature zone", () => {
    const { container, signatureChanges } = draw();
    fireDrop(signatureZone(container), [makeFile("contract.pdf")]);
    expect(signatureChanges).toHaveLength(1);
    expect(signatureChanges[0].map((file) => file.name)).toEqual(["contract.pdf"]);
  });

  it("appends a drop to files already chosen, skipping ones already there", () => {
    const { container, signatureChanges } = draw({
      signatureFiles: [makeFile("contract.pdf")],
    });
    fireDrop(signatureZone(container), [makeFile("contract.pdf"), makeFile("waiver.pdf")]);
    // Same name/size/mtime as the one already listed, so only the new document is added.
    expect(signatureChanges[0].map((file) => file.name)).toEqual(["contract.pdf", "waiver.pdf"]);
  });

  it("marks the zone while a drag is over it and clears it on leave", () => {
    const { container } = draw();
    const zone = signatureZone(container);
    zone.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    expect(zone.classList.contains("is-dragging")).toBe(true);
    zone.dispatchEvent(new Event("dragleave", { bubbles: true, cancelable: true }));
    expect(zone.classList.contains("is-dragging")).toBe(false);
  });

  it("clears the drag marker once the drop lands", () => {
    const { container } = draw();
    const zone = signatureZone(container);
    zone.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    fireDrop(zone, [makeFile("contract.pdf")]);
    expect(zone.classList.contains("is-dragging")).toBe(false);
  });

  it("lists chosen files and drops just the one whose remove is pressed", () => {
    const { container, signatureChanges } = draw({
      signatureFiles: [makeFile("contract.pdf"), makeFile("waiver.pdf")],
    });
    const rows = [...container.querySelectorAll(".logistics-upload__file-name")];
    expect(rows.map((row) => row.textContent)).toEqual(["contract.pdf", "waiver.pdf"]);

    container.querySelectorAll<HTMLButtonElement>(".logistics-upload__file button")[0].click();
    expect(signatureChanges[0].map((file) => file.name)).toEqual(["waiver.pdf"]);
  });

  it("shows no file list or clear action before anything is chosen", () => {
    const { container } = draw();
    expect(container.querySelector(".logistics-upload__files")).toBeNull();
    expect(container.querySelector(".adminbot-form__actions")).toBeNull();
  });
});

describe("supporting content", () => {
  it("shares one container with the signature section, below it", () => {
    const { container } = draw();
    const request = container.querySelector<HTMLElement>("[data-testid='logistics-request']");
    const supporting = container.querySelector<HTMLElement>("[data-testid='logistics-supporting']");
    expect(request).not.toBeNull();
    // One card holds both sections -- supporting content is inside it, not a card of its own.
    expect(supporting?.closest("[data-testid='logistics-request']")).toBe(request);
    expect(supporting?.classList.contains("card")).toBe(false);

    const headings = [
      ...(request?.querySelectorAll(".logistics-request__section > .card-title") ?? []),
    ];
    expect(headings.map((heading) => heading.textContent?.trim())).toEqual([
      "Document Signature",
      "Supporting Content (Optional)",
    ]);
  });

  it("labels the description and the attachments group", () => {
    const { container } = draw();
    const supporting = container.querySelector<HTMLElement>("[data-testid='logistics-supporting']");
    const labels = [...(supporting?.querySelectorAll(".logistics-supporting__field > span") ?? [])];
    expect(labels.map((label) => label.textContent?.trim())).toEqual([
      "Description",
      "Other Attachments",
    ]);
  });

  it("shows the description already typed and reports edits", () => {
    const { container, descriptionChanges } = draw({
      description: "Visa letter",
    });
    const field = describedTextarea(container);
    expect(field.value).toBe("Visa letter");

    field.value = "Visa letter, due the 8th";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(descriptionChanges).toEqual(["Visa letter, due the 8th"]);
  });

  it("takes any file type in the attachments zone", () => {
    const { container } = draw();
    const input = attachmentZone(container).querySelector<HTMLInputElement>("input[type='file']");
    // No accept list: supporting context arrives as whatever the member already has.
    expect(input?.hasAttribute("accept")).toBe(false);
    expect(input?.multiple).toBe(true);
  });

  it("reports attachments dropped onto their own zone, leaving the signature list alone", () => {
    const { container, attachmentChanges, signatureChanges } = draw();
    fireDrop(attachmentZone(container), [makeFile("itinerary.pdf")]);
    expect(attachmentChanges[0].map((file) => file.name)).toEqual(["itinerary.pdf"]);
    expect(signatureChanges).toEqual([]);
  });

  it("lists attachments separately from the documents to be signed", () => {
    const { container } = draw({
      signatureFiles: [makeFile("contract.pdf")],
      attachments: [makeFile("itinerary.pdf")],
    });
    const supporting = container.querySelector<HTMLElement>("[data-testid='logistics-supporting']");
    const names = [...(supporting?.querySelectorAll(".logistics-upload__file-name") ?? [])];
    expect(names.map((name) => name.textContent)).toEqual(["itinerary.pdf"]);
  });
});

describe("the signature Google Form signpost", () => {
  it("offers the form link instead of an upload zone for a new request", () => {
    const { container } = draw({ signatureEditing: false });

    const link = container.querySelector<HTMLAnchorElement>(
      "[data-testid='logistics-signature-form-link']",
    );
    expect(link?.getAttribute("href")).toBe(
      "https://docs.google.com/forms/d/1yNvSz65dU8hozDXhASuyFk8kvQuhj0hD2X9znHMzz9U",
    );
    expect(container.querySelector("[data-testid='logistics-signature-drop']")).toBeNull();
    expect(container.querySelector("[data-testid='logistics-supporting']")).toBeNull();
  });

  // It leaves the app, so it has to open away from the console and not hand the form the page it
  // was opened from.
  it("opens the form in a new tab without leaking the referrer", () => {
    const { container } = draw({ signatureEditing: false });
    const link = container.querySelector<HTMLAnchorElement>(
      "[data-testid='logistics-signature-form-link']",
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  // Nothing is filed from this tab any more, so none of the request controls belong on the card.
  it("carries no Save or Submit, since the form is what files the request", () => {
    const { container } = draw({ signatureEditing: false });
    expect(container.querySelector("[data-testid='logistics-submit']")).toBeNull();
    expect(container.querySelector(".logistics-request__actions")).toBeNull();
  });

  // The one case that still needs the old editor: a request filed before the switch, being fixed.
  it("still draws the upload form when an already-sent request is being corrected", () => {
    const { container } = draw({ signatureEditing: true });
    expect(container.querySelector("[data-testid='logistics-signature-drop']")).not.toBeNull();
    expect(container.querySelector("[data-testid='logistics-signature-form-link']")).toBeNull();
  });
});

describe("request actions", () => {
  function actionButtons(container: HTMLElement): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>(".logistics-request__actions .btn")];
  }

  // Read off Book Meeting rather than the signature form: the signature card only renders a form
  // while correcting an already-sent request, and a correction relabels these very buttons.
  it("puts Discard, Save and Submit at the bottom of the shared container", () => {
    const { container } = draw({ template: "bookMeeting" });
    const request = container.querySelector<HTMLElement>(
      "[data-testid='logistics-meeting-request']",
    );
    const actions = request?.querySelector(".logistics-request__actions");
    expect(actions).not.toBeNull();
    // Last thing in the card, after both sections.
    expect(request?.lastElementChild).toBe(actions);
    expect(actionButtons(container).map((button) => button.textContent?.trim())).toEqual([
      "Discard",
      "Save",
      "Submit",
    ]);
  });

  it("asks to save when Save is pressed", () => {
    const drawn = draw({ description: "Visa letter" });
    actionButtons(drawn.container)[1].click();
    expect(drawn.saves).toBe(1);
    expect(drawn.submits).toBe(0);
  });

  it("sends the request when Submit is pressed", () => {
    const drawn = draw({ signatureFiles: [makeFile("contract.pdf")] });
    actionButtons(drawn.container)[2].click();
    expect(drawn.submits).toBe(1);
    expect(drawn.saves).toBe(0);
  });

  it("throws away the form when Discard is pressed", () => {
    const drawn = draw({ description: "Visa letter" });
    actionButtons(drawn.container)[0].click();
    expect(drawn.discards).toBe(1);
  });

  it("offers nothing to discard on a form with nothing on it", () => {
    const { container } = draw({ hasContent: false });
    expect(actionButtons(container)[0].disabled).toBe(true);
  });

  it("blocks a second Save while one is in flight", () => {
    const { container } = draw({ saving: true });
    const save = actionButtons(container)[1];
    expect(save.disabled).toBe(true);
    expect(save.textContent?.trim()).toBe("Saving…");
  });

  it("blocks a second Submit while one is in flight, so one request is never filed twice", () => {
    const { container } = draw({ submitting: true });
    const submit = actionButtons(container)[2];
    expect(submit.disabled).toBe(true);
    expect(submit.textContent?.trim()).toBe("Sending…");
  });

  it("says why Submit would refuse, rather than leaving a dead button", () => {
    const { container } = draw({ submitBlocked: { reason: "empty" } });
    const blocked = container.querySelector("[data-testid='logistics-blocked']");
    expect(blocked?.textContent?.trim()).toBe("Fill the request in before sending it.");
    // Still pressable: pressing it is how a member finds out what is missing.
    expect(actionButtons(container)[2].disabled).toBe(false);
  });

  it("names the file that is too big, since that is the one thing the member has to act on", () => {
    const { container } = draw({
      submitBlocked: { reason: "file-too-big", file: "scan.pdf" },
    });
    expect(container.querySelector("[data-testid='logistics-blocked']")?.textContent).toContain(
      "scan.pdf",
    );
  });

  it("says a request landed, and stops saying what is missing once it has", () => {
    const { container } = draw({
      submitted: true,
      submitBlocked: { reason: "empty" },
    });
    expect(container.querySelector("[data-testid='logistics-submitted']")?.textContent).toContain(
      "Sent to the lab.",
    );
    expect(container.querySelector("[data-testid='logistics-blocked']")).toBeNull();
  });

  it("shows a submit failure ahead of anything the local draft has to say", () => {
    const { container } = draw({
      savedAt: Date.now(),
      submitError: "Could not reach the AdminBot service.",
    });
    const status = container.querySelector(".logistics-request__status");
    expect(status?.textContent).toContain("Could not reach the AdminBot service.");
    expect(status?.textContent).not.toContain("Saved on this device");
  });

  it("reports when the draft was last saved", () => {
    const savedAt = new Date(2026, 0, 15, 14, 32).getTime();
    const { container } = draw({ savedAt });
    const status = container.querySelector(".logistics-request__status")?.textContent ?? "";
    expect(status).toContain("Saved on this device at");
  });

  it("shows a save failure instead of a timestamp", () => {
    const { container } = draw({
      savedAt: Date.now(),
      saveError: "No local storage available.",
    });
    const status = container.querySelector(".logistics-request__status");
    expect(status?.textContent).toContain("No local storage available.");
    expect(status?.textContent).not.toContain("Saved on this device");
  });

  it("says nothing before the first save", () => {
    const { container } = draw();
    expect(container.querySelector(".logistics-request__status")?.textContent?.trim()).toBe("");
  });
});

describe("template selection", () => {
  it("shows one request container at a time", () => {
    const signature = draw();
    expect(signature.container.querySelector("[data-testid='logistics-request']")).not.toBeNull();
    expect(signature.container.querySelector("[data-testid='logistics-letters']")).toBeNull();
    expect(
      signature.container.querySelector("[data-testid='logistics-meeting-request']"),
    ).toBeNull();

    const letters = drawLetters();
    expect(letters.container.querySelector("[data-testid='logistics-request']")).toBeNull();
    expect(letters.container.querySelector("[data-testid='logistics-letters']")).not.toBeNull();

    const meeting = draw({ template: "bookMeeting" });
    expect(meeting.container.querySelector("[data-testid='logistics-letters']")).toBeNull();
    expect(
      meeting.container.querySelector("[data-testid='logistics-meeting-request']"),
    ).not.toBeNull();
  });
});

describe("list of schools", () => {
  // The facts table below reuses the same table styles, so every query here is scoped to the
  // schools section rather than to the card -- otherwise a column count is really two tables'.
  function schoolsTable(container: HTMLElement): HTMLElement {
    return container.querySelector<HTMLElement>("[data-testid='logistics-schools']")!;
  }

  function cellInput(container: HTMLElement, key: string): HTMLInputElement | null {
    return schoolsTable(container).querySelector<HTMLInputElement>(
      `.logistics-schools__cell--${key} input`,
    );
  }

  function removeButtons(container: HTMLElement): HTMLButtonElement[] {
    return [
      ...schoolsTable(container).querySelectorAll<HTMLButtonElement>(
        ".logistics-schools__cell--remove button",
      ),
    ];
  }

  it("leads the letters container, above Save and Submit", () => {
    const { container } = drawLetters();
    const card = container.querySelector<HTMLElement>("[data-testid='logistics-letters']");
    expect(card?.firstElementChild?.querySelector(".card-title")?.textContent?.trim()).toBe(
      "List of Schools",
    );
    expect(card?.lastElementChild?.classList.contains("logistics-request__actions")).toBe(true);
  });

  it("tracks a request by the eleven things a letter writer has to know", () => {
    const { container } = drawLetters();
    const names = [...schoolsTable(container).querySelectorAll(".logistics-schools__head-name")];
    expect(names.map((name) => name.textContent?.trim())).toEqual([
      "School",
      "Application deadline",
      // Each deadline carries its own clock, and one zone covers both: a school states its
      // cutoffs on one clock, so two zone columns would be two chances to disagree.
      "Time",
      "Letter deadline",
      "Time",
      "Time zone",
      "Application status",
      "Letter status",
      "Program",
      "Program link",
      "Program notes",
    ]);
  });

  it("qualifies the column names that need it", () => {
    const { container } = drawLetters();
    const hints = [...schoolsTable(container).querySelectorAll(".logistics-schools__head-hint")];
    expect(hints.map((hint) => hint.textContent?.trim())).toEqual([
      "if different",
      "for both times on this row",
      "If it is not a regular program, what it looks for.",
    ]);
  });

  it("gives every column of a row its own control", () => {
    const { container } = drawLetters({ schools: [createSchoolRow()] });
    const row = schoolsTable(container).querySelector<HTMLElement>(".logistics-schools__row");
    expect(row?.querySelectorAll("input, textarea")).toHaveLength(11);
    expect(cellInput(container, "applicationDeadline")?.type).toBe("date");
    expect(cellInput(container, "applicationDeadlineTime")?.type).toBe("time");
    expect(cellInput(container, "letterDeadline")?.type).toBe("date");
    expect(cellInput(container, "letterDeadlineTime")?.type).toBe("time");
    expect(cellInput(container, "programLink")?.type).toBe("url");
    // A note is a sentence about the program, not a word.
    expect(row?.querySelector(".logistics-schools__cell--notes textarea")).not.toBeNull();
  });

  it("suggests the usual status words without holding a member to them", () => {
    const { container } = drawLetters({ schools: [createSchoolRow()] });
    const status = cellInput(container, "applicationStatus");
    // Free text with a datalist, so "waitlisted" is still sayable.
    expect(status?.type).toBe("text");
    const options = container.querySelectorAll(`#${status?.getAttribute("list")} option`);
    expect([...options].map((option) => option.getAttribute("value"))).toEqual([
      "submitted",
      "accepted",
      "declined",
    ]);
    const letterStatus = cellInput(container, "letterStatus");
    const letterOptions = container.querySelectorAll(
      `#${letterStatus?.getAttribute("list")} option`,
    );
    expect([...letterOptions].map((option) => option.getAttribute("value"))).toEqual([
      "requested",
      "submitted",
    ]);
  });

  it("shows what a row holds and reports an edit against that row alone", () => {
    const stanford = createSchoolRow({ school: "Stanford" });
    const mit = createSchoolRow({ school: "MIT" });
    const drawn = drawLetters({ schools: [stanford, mit] });
    const fields = [
      ...drawn.container.querySelectorAll<HTMLInputElement>(
        ".logistics-schools__cell--school input",
      ),
    ];
    expect(fields.map((field) => field.value)).toEqual(["Stanford", "MIT"]);

    fields[1].value = "MIT EECS";
    fields[1].dispatchEvent(new Event("input", { bubbles: true }));
    expect(drawn.schoolChanges).toHaveLength(1);
    expect(drawn.schoolChanges[0].map((row) => row.school)).toEqual(["Stanford", "MIT EECS"]);
    // The row that was not edited comes back untouched, not a copy.
    expect(drawn.schoolChanges[0][0]).toBe(stanford);
  });

  it("adds a blank row under the ones already filled in", () => {
    const drawn = drawLetters({
      schools: [createSchoolRow({ school: "Stanford" })],
    });
    drawn.container.querySelector<HTMLButtonElement>(".logistics-schools__actions .btn")?.click();
    expect(drawn.schoolChanges[0].map((row) => row.school)).toEqual(["Stanford", ""]);
  });

  it("drops just the row whose remove is pressed", () => {
    const drawn = drawLetters({
      schools: [createSchoolRow({ school: "Stanford" }), createSchoolRow({ school: "MIT" })],
    });
    removeButtons(drawn.container)[0].click();
    expect(drawn.schoolChanges[0].map((row) => row.school)).toEqual(["MIT"]);
  });

  it("names the remove button after the school, or the row while it is still blank", () => {
    const { container } = drawLetters({
      schools: [createSchoolRow({ school: "Stanford" }), createSchoolRow()],
    });
    expect(removeButtons(container).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Remove Stanford",
      "Remove row 2",
    ]);
  });

  it("labels each control by its column and row", () => {
    const { container } = drawLetters({
      schools: [createSchoolRow(), createSchoolRow()],
    });
    const notes = [...container.querySelectorAll(".logistics-schools__cell--notes textarea")];
    expect(notes.map((note) => note.getAttribute("aria-label"))).toEqual([
      "Program notes, row 1",
      "Program notes, row 2",
    ]);
  });

  it("says the table is empty rather than showing a bare header", () => {
    const { container } = drawLetters({ schools: [] });
    expect(container.querySelectorAll(".logistics-schools__row")).toHaveLength(0);
    expect(container.querySelector(".logistics-schools__empty")?.textContent).toContain(
      "No schools yet",
    );
  });

  it("saves the letters draft on its own Save, and reports its own outcome", () => {
    const drawn = drawLetters({
      // The signature form's save state must not leak into this container.
      savedAt: Date.now(),
      lettersSaveError: "No local storage available.",
    });
    const actions = [
      ...drawn.container.querySelectorAll<HTMLButtonElement>(".logistics-request__actions .btn"),
    ];
    expect(actions.map((button) => button.textContent?.trim())).toEqual([
      "Discard",
      "Save",
      "Submit",
    ]);

    actions[1].click();
    expect(drawn.lettersSaves).toBe(1);
    expect(drawn.saves).toBe(0);
    // Submit is the letters form's own too, not the signature form's.
    actions[2].click();
    expect(drawn.lettersSubmits).toBe(1);
    expect(drawn.submits).toBe(0);

    const status = drawn.container.querySelector(".logistics-request__status");
    expect(status?.textContent).toContain("No local storage available.");
    expect(status?.textContent).not.toContain("Saved on this device");
  });
});

describe("letter request links", () => {
  const TEMPLATE_FOLDER =
    "https://drive.google.com/drive/folders/1Ld_fhN--dk1P2bM9P_3W-TsYgsQG0Wj2";

  function section(container: HTMLElement, testId: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(`[data-testid='${testId}']`);
    if (!found) {
      throw new Error(`section ${testId} missing`);
    }
    return found;
  }

  function linkInput(container: HTMLElement, testId: string): HTMLInputElement {
    const input = section(container, testId).querySelector<HTMLInputElement>("input");
    if (!input) {
      throw new Error(`input for ${testId} missing`);
    }
    return input;
  }

  it("puts both link fields between the facts table and the actions", () => {
    const { container } = drawLetters();
    const card = section(container, "logistics-letters");
    const sections = [...card.querySelectorAll(":scope > .logistics-request__section")];
    expect(sections.map((entry) => entry.getAttribute("data-testid"))).toEqual([
      "logistics-schools",
      // What the member did comes before where the letter is written and stored: it is the part
      // only they can supply, and the two links are plumbing for it.
      "logistics-facts",
      "logistics-cv-overleaf",
      "logistics-drive-folder",
    ]);
  });

  it("labels each box by the heading that names it", () => {
    const { container } = drawLetters();
    const cv = section(container, "logistics-cv-overleaf");
    const heading = cv.querySelector<HTMLElement>(".card-title");
    expect(heading?.textContent?.trim()).toBe("CV Overleaf Link (editable)");
    const input = linkInput(container, "logistics-cv-overleaf");
    expect(input.type).toBe("url");
    // The heading is the field's only visible name, so it has to be the accessible one too.
    expect(input.getAttribute("aria-labelledby")).toBe(heading?.id);
    expect(heading?.id).toBeTruthy();
  });

  it("sends the member to the lab's template folder and asks for their own back", () => {
    const { container } = drawLetters();
    const drive = section(container, "logistics-drive-folder");
    expect(drive.querySelector(".card-title")?.textContent?.trim()).toBe("Google Drive Link");
    const link = drive.querySelector<HTMLAnchorElement>(".logistics-link__folder");
    expect(link?.getAttribute("href")).toBe(TEMPLATE_FOLDER);
    // Opens beside the request rather than over it -- the member is part-way through this form.
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
    expect(drive.querySelector(".card-sub")?.textContent).toContain(
      "paste that folder's link below",
    );
  });

  it("shows the links already saved and reports each box on its own", () => {
    const drawn = drawLetters({
      cvOverleafUrl: "https://www.overleaf.com/project/abc",
    });
    expect(linkInput(drawn.container, "logistics-cv-overleaf").value).toBe(
      "https://www.overleaf.com/project/abc",
    );
    const drive = linkInput(drawn.container, "logistics-drive-folder");
    expect(drive.value).toBe("");

    drive.value = "https://drive.google.com/drive/folders/mine";
    drive.dispatchEvent(new Event("input", { bubbles: true }));
    expect(drawn.driveFolderChanges).toEqual(["https://drive.google.com/drive/folders/mine"]);
    expect(drawn.cvOverleafChanges).toEqual([]);
  });
});

describe("request modes", () => {
  const letters: LogisticsRequest = {
    id: "logreq_letters",
    kind: "recommendation_letters",
    member_id: "ada",
    member_name: "Ada Lovelace",
    status: "submitted",
    submitted_at: "2026-08-01T09:30:00.000Z",
    updated_at: "2026-08-01T09:30:00.000Z",
    deadline_at: "2026-12-01T23:59:00.000Z",
    schools: [{ school: "Stanford", application_deadline: "2026-12-01" }],
    facts: [{ project: "Causal NLP", contribution: "ran the ablations" }],
    cv_overleaf_url: "https://www.overleaf.com/project/abc",
  };
  const signature: LogisticsRequest = {
    id: "logreq_signature",
    kind: "document_signature",
    member_id: "ada",
    member_name: "Ada Lovelace",
    status: "in_progress",
    submitted_at: "2026-08-02T09:30:00.000Z",
    updated_at: "2026-08-02T09:30:00.000Z",
    documents: [{ name: "visa-letter.pdf", size: 2048 }],
    description: "Needs the head's signature.",
    attachments: [],
  };
  const meeting: LogisticsRequest = {
    id: "logreq_meeting",
    kind: "book_meeting",
    member_id: "grace",
    member_name: "Grace Hopper",
    status: "submitted",
    submitted_at: "2026-08-03T09:30:00.000Z",
    updated_at: "2026-08-03T09:30:00.000Z",
    // 14:00 in Toronto, as the service resolved it on the way in.
    deadline_at: "2026-09-01T18:00:00.000Z",
    meetings: [
      {
        purpose: "thesis check-in",
        preferred_time: "2026-09-01T14:00",
        timezone: "America/Toronto",
        length_minutes: 30,
      },
    ],
  };

  it("offers a member their own requests, without calling it the lab's", () => {
    const { container } = draw({ role: "member" });
    const admin = container.querySelector<HTMLElement>("[data-testid='logistics-admin']");
    expect(modeButtons(container).map((button) => button.textContent?.trim())).toEqual([
      "Make a Request",
      "My Requests",
    ]);
    // The admin badge is the one part that stays admin-only: it says whose queue you are reading.
    expect(admin?.textContent).not.toContain("Admins only");
  });

  it("shows a member the requests they sent, and says they are theirs", () => {
    const { container } = draw({
      role: "member",
      mode: "view",
      requests: [letters],
    });
    const list = container.querySelector<HTMLElement>("[data-testid='logistics-requests']");
    expect(list?.querySelector(".card-title")?.textContent?.trim()).toBe("My Requests");
    // No User column: every row on this list is the reader.
    expect(
      [...container.querySelectorAll(".logistics-requests__head")].map((head) =>
        head.textContent?.trim(),
      ),
    ).toEqual(["Type of Request", "Most Recent Deadline", "Status"]);
  });

  it("offers an admin the two modes above the templates", () => {
    const { container } = draw({ role: "admin" });
    const admin = container.querySelector<HTMLElement>("[data-testid='logistics-admin']");
    expect(modeButtons(container).map((button) => button.textContent?.trim())).toEqual([
      "Make a Request",
      "View Current Requests",
    ]);
    // Above the Templates card, since it decides what the rest of the page is.
    const shell = container.querySelector<HTMLElement>("[data-testid='adminbot-logistics']");
    expect(shell?.firstElementChild).toBe(admin);
    expect(admin?.textContent).toContain("Admins only");
  });

  it("stays on Make a Request until the list is asked for", () => {
    const drawn = draw({ role: "admin" });
    expect(modeButtons(drawn.container)[0].getAttribute("aria-pressed")).toBe("true");
    expect(drawn.container.querySelector("[data-testid='logistics-request']")).not.toBeNull();

    modeButtons(drawn.container)[1].click();
    expect(drawn.modeChanges).toEqual(["view"]);
  });

  it("swaps the form for the queue in view mode", () => {
    const { container } = draw({
      role: "admin",
      mode: "view",
      requests: [letters],
    });
    // An admin gets the spreadsheet; the member's own list is the other shape of the same data.
    expect(container.querySelector("[data-testid='logistics-queue']")).not.toBeNull();
    // Reading the lab's requests is not the moment to be offered a new one.
    expect(container.querySelector("[data-testid='logistics-request']")).toBeNull();
    expect(container.querySelector("[data-testid='logistics-letters']")).toBeNull();
  });

  it("gives a member the list rather than the admin's spreadsheet", () => {
    const { container } = draw({ role: "member", mode: "view", requests: [letters] });
    expect(container.querySelector("[data-testid='logistics-requests']")).not.toBeNull();
    expect(container.querySelector("[data-testid='logistics-queue']")).toBeNull();
  });

  it("lists a member's own requests by type, soonest deadline and where each stands", () => {
    const { container } = draw({
      role: "member",
      mode: "view",
      requests: [letters, signature, meeting],
    });
    const headings = [...container.querySelectorAll(".logistics-requests__head")];
    expect(headings.map((heading) => heading.textContent?.trim())).toEqual([
      "Type of Request",
      "Most Recent Deadline",
      "Status",
    ]);
    const rows = [...container.querySelectorAll(".logistics-requests__row")];
    expect(rows.map((row) => row.textContent?.replace(/\s+/gu, " ").trim())).toEqual([
      "Recommendation Letters Dec 1, 2026 Submitted",
      // A signature request names no date, so it says so rather than inventing one.
      "Document Signature No deadline In progress",
      "Book Meeting Sep 1, 2026 Submitted",
    ]);
  });

  it("says the list is empty rather than showing a bare header", () => {
    const member = draw({ role: "member", mode: "view", requests: [] });
    expect(member.container.querySelector(".logistics-requests__empty")?.textContent).toContain(
      "You have not sent a request yet",
    );
  });

  it("reports a list that could not be read, instead of an empty one", () => {
    const { container } = draw({
      role: "admin",
      mode: "view",
      requests: [],
      requestsError: "Could not reach the AdminBot service at http://127.0.0.1:8765.",
    });
    expect(container.querySelector(".logistics-requests__error")?.textContent).toContain(
      "Could not reach the AdminBot service",
    );
  });

  it("opens a request from its row", () => {
    const drawn = draw({ role: "admin", mode: "view", requests: [letters] });
    drawn.container.querySelector<HTMLButtonElement>(".logistics-requests__open")?.click();
    expect(drawn.opened).toContain("logreq_letters");
  });

  it("waits rather than showing the list again while a request is being opened", () => {
    const { container } = draw({
      role: "admin",
      mode: "view",
      requests: [letters],
      openLoading: true,
    });
    expect(container.querySelector(".logistics-requests__table")).toBeNull();
    expect(container.querySelector(".logistics-requests__empty")?.textContent).toContain(
      "Reading requests…",
    );
  });

  it("shows a letters request in full, read-only, with a way back", () => {
    const { container } = draw({
      role: "admin",
      mode: "view",
      openRequest: letters,
    });
    const detail = container.querySelector<HTMLElement>("[data-testid='logistics-request-detail']");
    expect(detail).not.toBeNull();
    expect(container.querySelector("[data-testid='logistics-requests']")).toBeNull();
    expect(detail?.querySelector(".card-title")?.textContent?.trim()).toBe("Ada Lovelace");
    // Every column of the member's table, plus the two the facts table adds -- and no input an
    // admin could type the member's answers into. The note box is the one control here, and it
    // belongs to the answer, not to the request.
    expect(detail?.textContent).toContain("Stanford");
    expect(detail?.querySelectorAll("input")).toHaveLength(0);
    expect(detail?.textContent).toContain("https://www.overleaf.com/project/abc");
  });

  it("shows the facts a letter is written from, which the writer cannot get anywhere else", () => {
    const { container } = draw({
      role: "admin",
      mode: "view",
      openRequest: letters,
    });
    const detail = container.querySelector<HTMLElement>("[data-testid='logistics-request-detail']");
    expect(detail?.textContent).toContain("Causal NLP");
    expect(detail?.textContent).toContain("ran the ablations");
  });

  it("shows a meeting request's rows, which used to be readable nowhere", () => {
    const { container } = draw({
      role: "admin",
      mode: "view",
      openRequest: meeting,
    });
    const detail = container.querySelector<HTMLElement>("[data-testid='logistics-request-detail']");
    expect(detail?.textContent).toContain("thesis check-in");
    expect(detail?.textContent).toContain("America/Toronto");
    expect(detail?.textContent).toContain("30 min");
  });

  it("shows a signature request's documents and description", () => {
    const { container } = draw({
      role: "admin",
      mode: "view",
      openRequest: signature,
    });
    const detail = container.querySelector<HTMLElement>("[data-testid='logistics-request-detail']");
    expect(detail?.textContent).toContain("visa-letter.pdf");
    expect(detail?.textContent).toContain("Needs the head's signature.");
    expect(detail?.textContent).toContain("2.0 KB");
  });

  it("offers a document as a download once its bytes are there", () => {
    const withBytes: LogisticsRequest = {
      ...signature,
      documents: [{ name: "visa-letter.pdf", size: 5, data_base64: "aGVsbG8=" }],
    };
    const { container } = draw({
      role: "admin",
      mode: "view",
      openRequest: withBytes,
    });
    const link = container.querySelector<HTMLAnchorElement>(".logistics-detail__files a");
    expect(link?.getAttribute("download")).toBe("visa-letter.pdf");
    expect(link?.getAttribute("href")).toContain("base64,aGVsbG8=");
  });

  it("goes back to the list", () => {
    const drawn = draw({ role: "admin", mode: "view", openRequest: letters });
    drawn.container.querySelector<HTMLButtonElement>(".logistics-detail__back .btn")?.click();
    expect(drawn.opened).toEqual([null]);
  });
});

describe("answering a request", () => {
  const request: LogisticsRequest = {
    id: "logreq_1",
    kind: "document_signature",
    member_id: "ada",
    member_name: "Ada Lovelace",
    status: "submitted",
    submitted_at: "2026-08-02T09:30:00.000Z",
    updated_at: "2026-08-02T09:30:00.000Z",
    documents: [{ name: "visa-letter.pdf", size: 2048 }],
  };

  function answerButtons(container: HTMLElement): HTMLButtonElement[] {
    const answer = container.querySelector<HTMLElement>("[data-testid='logistics-answer']");
    return [...(answer?.querySelectorAll<HTMLButtonElement>(".btn") ?? [])];
  }

  it("offers an admin the three answers, and never 'withdrawn'", () => {
    const { container } = draw({
      role: "admin",
      mode: "view",
      openRequest: request,
    });
    expect(answerButtons(container).map((button) => button.textContent?.trim())).toEqual([
      "In progress",
      "Done",
      "Declined",
    ]);
  });

  it("sends the answer with the note the admin typed", () => {
    const drawn = draw({
      role: "admin",
      mode: "view",
      openRequest: request,
      statusNote: "signed and in your pigeonhole",
    });
    answerButtons(drawn.container)[1].click();
    expect(drawn.answers).toEqual([
      {
        id: "logreq_1",
        status: "completed",
        note: "signed and in your pigeonhole",
      },
    ]);
  });

  it("reports an edit to the note against app state, so a reload underneath cannot eat it", () => {
    const drawn = draw({ role: "admin", mode: "view", openRequest: request });
    const note = drawn.container.querySelector<HTMLTextAreaElement>(".logistics-detail__note");
    note!.value = "asking the head first";
    note!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(drawn.noteChanges).toEqual(["asking the head first"]);
  });

  it("does not offer a member the answer controls at all", () => {
    const { container } = draw({
      role: "member",
      mode: "view",
      openRequest: request,
    });
    expect(container.querySelector("[data-testid='logistics-answer']")).toBeNull();
  });

  it("shows the member what the lab said back", () => {
    const { container } = draw({
      role: "member",
      mode: "view",
      openRequest: {
        ...request,
        status: "declined",
        resolution_note: "ask again in May",
      },
    });
    expect(container.querySelector("[data-testid='logistics-resolution']")?.textContent).toContain(
      "ask again in May",
    );
  });
});

describe("correcting a request already sent", () => {
  const mine: LogisticsRequest = {
    id: "logreq_mine",
    kind: "document_signature",
    member_id: "ada",
    member_name: "Ada Lovelace",
    status: "submitted",
    submitted_at: "2026-08-02T09:30:00.000Z",
    updated_at: "2026-08-02T09:30:00.000Z",
    documents: [{ name: "visa-letter.pdf", size: 2048 }],
  };

  function editButton(container: HTMLElement): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>("[data-testid='logistics-edit']");
  }

  it("offers the requester their request back", () => {
    const drawn = draw({ role: "member", mode: "view", openRequest: mine });
    editButton(drawn.container)?.click();
    expect(drawn.edited).toEqual(["logreq_mine"]);
  });

  it("stops offering it once the lab has picked the request up", () => {
    // An edit past this point would move the ground under an admin mid-way through, and the
    // service refuses it anyway.
    for (const status of ["in_progress", "completed", "declined", "withdrawn"] as const) {
      const { container } = draw({
        role: "member",
        mode: "view",
        openRequest: { ...mine, status },
      });
      expect(editButton(container)).toBeNull();
    }
  });

  it("is not offered on somebody else's request, however privileged the reader", () => {
    const { container } = draw({
      role: "admin",
      mode: "view",
      viewerMemberId: "zhijing",
      openRequest: mine,
    });
    expect(editButton(container)).toBeNull();
  });

  it("says the form holds a correction, since it looks like a new request otherwise", () => {
    const { container } = draw({ editing: true });
    expect(container.querySelector("[data-testid='logistics-editing']")?.textContent).toContain(
      "Correcting a request you already sent",
    );
    expect(
      container.querySelector<HTMLButtonElement>("[data-testid='logistics-submit']")?.textContent,
    ).toContain("Send the correction");
  });

  it("lets the member abandon the correction and start a new request", () => {
    const drawn = draw({ editing: true });
    drawn.container
      .querySelector<HTMLElement>("[data-testid='logistics-editing']")
      ?.querySelector<HTMLButtonElement>("button")
      ?.click();
    expect(drawn.cancelledEdits).toBe(1);
  });

  it("says nothing about correcting on a form holding a new request", () => {
    const { container } = draw({ template: "bookMeeting" });
    expect(container.querySelector("[data-testid='logistics-editing']")).toBeNull();
  });
});

describe("withdrawing a request", () => {
  const mine: LogisticsRequest = {
    id: "logreq_mine",
    kind: "document_signature",
    member_id: "ada",
    member_name: "Ada Lovelace",
    status: "submitted",
    submitted_at: "2026-08-02T09:30:00.000Z",
    updated_at: "2026-08-02T09:30:00.000Z",
    documents: [{ name: "visa-letter.pdf", size: 2048 }],
  };

  function withdrawButton(container: HTMLElement): HTMLButtonElement | null {
    return (
      [...container.querySelectorAll<HTMLButtonElement>(".logistics-detail__actions .btn")].find(
        (button) => button.textContent?.includes("Withdraw"),
      ) ?? null
    );
  }

  it("lets the requester call their own request off", () => {
    const drawn = draw({ role: "member", mode: "view", openRequest: mine });
    withdrawButton(drawn.container)?.click();
    expect(drawn.withdrawn).toEqual(["logreq_mine"]);
  });

  it("is not offered on somebody else's request", () => {
    const { container } = draw({
      role: "admin",
      mode: "view",
      viewerMemberId: "zhijing",
      openRequest: mine,
    });
    expect(withdrawButton(container)).toBeNull();
  });

  it("is not offered once there is nothing left to call off", () => {
    for (const status of ["completed", "withdrawn"] as const) {
      const { container } = draw({
        role: "member",
        mode: "view",
        openRequest: { ...mine, status },
      });
      expect(withdrawButton(container)).toBeNull();
    }
  });
});

// The letter itself stays a Drive template. What a template cannot hold is which project and what
// the member did on it, which is why this table exists and why the weekly updates it draws on are
// pointed at rather than asked for again.
describe("list of facts", () => {
  function factsTable(container: HTMLElement): HTMLElement {
    return container.querySelector<HTMLElement>("[data-testid='logistics-facts']")!;
  }

  it("asks for one row per project, and routes to where the weekly updates already are", () => {
    const drawn = drawLetters({
      facts: [createFactRow({ project: "Causal NLP" })],
    });
    const table = factsTable(drawn.container);
    const names = [...table.querySelectorAll(".logistics-schools__head-name")];
    expect(names.map((name) => name.textContent?.trim())).toEqual(["Project", "What you did"]);
    expect(table.querySelector<HTMLInputElement>("input")?.value).toBe("Causal NLP");

    table.querySelector<HTMLButtonElement>(".logistics-facts__link")?.click();
    expect(drawn.myProjectsOpened).toBe(1);
  });

  it("adds and removes a row without touching the others", () => {
    const rows = [createFactRow({ project: "Causal NLP" }), createFactRow({ project: "Nudges" })];
    const added = drawLetters({ facts: rows });
    factsTable(added.container)
      .querySelector<HTMLButtonElement>("[data-testid='logistics-facts-add']")
      ?.click();
    expect(added.factChanges[0]).toHaveLength(3);
    expect(added.factChanges[0].slice(0, 2)).toEqual(rows);

    const removed = drawLetters({ facts: rows });
    factsTable(removed.container)
      .querySelectorAll<HTMLButtonElement>(".logistics-schools__cell--remove button")[0]
      ?.click();
    expect(removed.factChanges[0]).toEqual([rows[1]]);
  });

  it("says the table is empty rather than showing a bare header", () => {
    const { container } = drawLetters({ facts: [] });
    expect(factsTable(container).querySelector(".logistics-schools__empty")).not.toBeNull();
  });
});

// A meeting request is four short facts, and whoever schedules them reads many at once.
describe("book meeting", () => {
  function drawMeeting(options: Omit<DrawOptions, "template"> = {}): Drawn {
    return draw({ ...options, template: "bookMeeting" });
  }

  it("lays a request out as a row: when they asked, what for, when, on whose clock, how long", () => {
    const { container } = drawMeeting({ meetings: [createMeetingRow()] });
    const names = [...container.querySelectorAll(".logistics-schools__head-name")];
    expect(names.map((name) => name.textContent?.trim())).toEqual([
      "Submitted",
      "What the call is for",
      "Preferred time",
      "Time zone",
      "Call length (min)",
    ]);
  });

  // Order of service is decided by when the request arrived, so it is the one field a requester
  // must not be able to write.
  it("stamps the submitted time rather than offering it as a control", () => {
    const { container } = drawMeeting({ meetings: [createMeetingRow()] });
    const row = container.querySelector<HTMLElement>(".logistics-schools__row")!;
    expect(row.querySelector(".logistics-meeting__submitted input")).toBeNull();
    expect(row.querySelector(".logistics-meeting__submitted")?.textContent?.trim()).not.toBe("");
    // The four columns a member fills in, and no fifth.
    expect(row.querySelectorAll("input")).toHaveLength(4);
  });

  it("prefills the zone from the browser so a proposed time means a real instant", () => {
    const { container } = drawMeeting({ meetings: [createMeetingRow()] });
    const zone = [...container.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.getAttribute("list") !== null,
    );
    expect(zone?.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("reports an edit against the row it was made in", () => {
    const rows = [createMeetingRow(), createMeetingRow()];
    const drawn = drawMeeting({ meetings: rows });
    const lengths = [...drawn.container.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    lengths[1].value = "45";
    lengths[1].dispatchEvent(new Event("input"));
    expect(drawn.meetingChanges[0][0].lengthMinutes).toBe("");
    expect(drawn.meetingChanges[0][1].lengthMinutes).toBe("45");
  });

  it("saves the meeting draft on its own Save, and reports its own outcome", () => {
    const drawn = drawMeeting({
      meetings: [createMeetingRow()],
      meetingSavedAt: 0,
    });
    const actions = [
      ...drawn.container.querySelectorAll<HTMLButtonElement>(".logistics-request__actions .btn"),
    ];
    actions[1].click();
    expect(drawn.meetingSaves).toBe(1);
    expect(drawn.saves).toBe(0);
    expect(drawn.lettersSaves).toBe(0);

    actions[2].click();
    expect(drawn.meetingSubmits).toBe(1);
    expect(drawn.submits).toBe(0);
    expect(drawn.lettersSubmits).toBe(0);
  });

  it("opens empty rather than stamping a request nobody made", () => {
    const { container } = drawMeeting();
    expect(container.querySelector(".logistics-schools__empty")).not.toBeNull();
  });
});
