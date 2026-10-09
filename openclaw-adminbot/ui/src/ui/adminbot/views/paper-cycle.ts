import { html, nothing } from "lit";
import {
  X_ANNOUNCEMENT_STAGES,
  readXThreadDraft,
  xDraftLength,
  type XAnnouncementDetails,
  type XAnnouncementStage,
  type XCreditSelection,
} from "../../../../../extensions/adminbot/src/workflows/papers/x-draft.js";
import { icons } from "../../icons.ts";
import type {
  PaperAttendee,
  PaperReimbursement,
  PaperSocialConsent,
  PaperSocialDraft,
} from "../auth/session.ts";
// The parts of a paper card that are lists rather than single fields: the social drafts and who
// has signed off on them, who is going to the conference, and who has been reimbursed.
//
// Kept apart from the slot checklist above it because they behave differently. A slot is one
// answer with one owner; each of these is a set of rows about several people, and the useful
// question is "who has not answered yet" rather than "is it filled in".
import { renderDateControl } from "../date-control.ts";

export type PaperCycleProps = {
  paperId: string;
  drafts: PaperSocialDraft[];
  consents: PaperSocialConsent[];
  attendees: PaperAttendee[];
  reimbursements: PaperReimbursement[];
  /** Whether the venue said yes and the acceptance details are all in. */
  conferenceOpen: boolean;
  missingAcceptanceDetails: string[];
  cycleClosed: boolean;
  /** The signed-in member, so their own consent row gets buttons and nobody else's does. */
  memberId: string | null;
  memberName: (memberId: string) => string;
  paperAuthors?: string[];
  creditMembers?: Array<{ id: string; name: string; twitter_url?: string; affiliation?: string }>;
  onSaveDraft: (
    platform: string,
    body: string,
    xThread?: import("../../../../../extensions/adminbot/src/workflows/papers/x-draft.js").XThreadDraft,
  ) => void;
  onCirculateDraft: (draftId: string) => void;
  /**
   * LinkedIn only: run the model draft with the panel's venue/context inputs and store the text.
   * `pdfBase64` is a PDF dropped on the panel; absent, the service reads the card's Drive copy.
   */
  onGenerateLinkedInDraft?: (venue: string, note: string, pdfBase64?: string) => void;
  onGenerateXDraft?: (
    venue: string,
    note: string,
    pdfBase64?: string,
    announcement?: XAnnouncementDetails,
    credits?: XCreditSelection,
  ) => void;
  onConsent: (draftId: string, decision: string, comment?: string) => void;
  onSetAttendee: (name: string, memberId: string | undefined, attending: string) => void;
  /**
   * The reader's own trip to this paper's conference, and the controls to change it.
   *
   * Optional as a set: a surface with no trip wiring simply does not draw the block, rather than
   * drawing one whose buttons do nothing. Active Papers reuses this renderer over other people's
   * papers, and "what do *you* need paid for" is not a question to put on somebody else's card.
   */
  myTrip?: PaperTrip | null;
  tripDraft?: PaperTripDraft;
  tripSaving?: boolean;
  onEditTrip?: (patch: Partial<PaperTripDraft>) => void;
  onSaveTrip?: () => void;
  onWithdrawTrip?: () => void;
  onSetReimbursement: (memberId: string, status: string) => void;
};

const PLATFORM_LABELS: Record<string, string> = { x: "X", linkedin: "LinkedIn" };

const REIMBURSEMENT_LABELS: Record<string, string> = {
  not_applicable: "Not applicable",
  pending: "Not filed yet",
  submitted: "Submitted",
  reimbursed: "Reimbursed",
};

const ATTENDING_LABELS: Record<string, string> = {
  yes: "Going",
  no: "Not going",
  unknown: "Not said yet",
};

/**
 * The live draft per platform.
 *
 * Superseded rows are kept by the service so "what did they actually approve" stays answerable,
 * but the card shows the current one -- the history is an audit question, not a daily one.
 */
function liveDraft(drafts: PaperSocialDraft[], platform: string): PaperSocialDraft | undefined {
  return drafts.find((draft) => draft.platform === platform && draft.status !== "superseded");
}

function renderConsentRow(props: PaperCycleProps, consent: PaperSocialConsent) {
  const mine = consent.member_id === props.memberId;
  return html`
    <li class="paper-cycle__consent" data-decision=${consent.decision}>
      <span class="paper-cycle__consent-name">${props.memberName(consent.member_id)}</span>
      <span class="paper-cycle__consent-state">
        ${consent.decision === "ok"
          ? "Approved"
          : consent.decision === "changes_requested"
            ? "Asked for changes"
            : "Waiting"}
      </span>
      ${consent.comment
        ? html`<span class="paper-cycle__consent-comment">${consent.comment}</span>`
        : nothing}
      ${mine && consent.decision === "pending"
        ? html`
            <span class="paper-cycle__consent-actions">
              <button
                type="button"
                class="btn btn--sm"
                data-testid=${`consent-ok-${consent.draft_id}`}
                @click=${() => props.onConsent(consent.draft_id, "ok")}
              >
                Looks good
              </button>
              <button
                type="button"
                class="btn btn--sm"
                data-testid=${`consent-changes-${consent.draft_id}`}
                @click=${(event: Event) => {
                  const comment = globalThis.prompt?.("What would you change?") ?? "";
                  if (comment.trim()) {
                    props.onConsent(consent.draft_id, "changes_requested", comment.trim());
                  }
                  (event.currentTarget as HTMLButtonElement).blur();
                }}
              >
                Ask for changes
              </button>
            </span>
          `
        : nothing}
    </li>
  `;
}

// Matches the service's ceiling on /papers/linkedin-draft, so an oversize file is refused here
// with a message rather than as a 413 after the whole thing has been uploaded.
export const LINKEDIN_DRAFT_PDF_MAX_BYTES = 20 * 1024 * 1024;

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

async function readPdfBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

// The chosen PDF lives on the file input itself rather than in app state, the same way the venue
// and context inputs beside it do: Generate reads all three off the DOM when clicked, and a
// re-render leaves an input's files alone, so nothing has to be threaded through the view.
function choosePdf(zone: HTMLElement, files: FileList | null | undefined): void {
  const input = zone.querySelector<HTMLInputElement>('[data-el="pdf"]');
  const title = zone.querySelector<HTMLElement>('[data-el="pdf-name"]');
  const file = files?.[0];
  if (!input || !title || !files || !file) {
    return;
  }
  if (!isPdf(file) || file.size > LINKEDIN_DRAFT_PDF_MAX_BYTES) {
    globalThis.alert?.(isPdf(file) ? "That PDF is over 20 MB." : `${file.name} is not a PDF.`);
    input.value = "";
    title.textContent = "Drop the paper PDF here";
    return;
  }
  // A drop hands over the drag's own FileList; a click-to-pick already put it on the input.
  if (input.files !== files) {
    input.files = files;
  }
  title.textContent = file.name;
}

function setPdfDragging(event: DragEvent, dragging: boolean): void {
  const zone = event.currentTarget;
  if (zone instanceof HTMLElement) {
    zone.classList.toggle("is-dragging", dragging);
  }
}

/**
 * One platform's draft, and who still owes a sign-off on it.
 *
 * The consent list is the point of storing drafts at all: a post that names a senior author has to
 * be shown to that author, and this is where "shown to" becomes a record rather than a memory.
 */
const X_STAGE_LABELS = {
  arxiv: "arXiv release",
  acceptance: "Conference acceptance",
  attendance: "Going to the conference",
  poster: "Poster — come chat",
};

async function readXFigure(file: File): Promise<string> {
  if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 512 * 1024) {
    throw new Error("Choose a PNG/JPEG figure under 512 KB.");
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read the figure.")),
    );
    reader.addEventListener("error", () => reject(new Error("Could not read the figure.")));
    reader.readAsDataURL(file);
  });
}

function renderXThreadEditor(props: PaperCycleProps, draft: PaperSocialDraft) {
  const thread = draft.x_thread;
  if (!thread) {
    return nothing;
  }
  return html`<div class="paper-cycle__composer">
    <form
      class="paper-cycle__thread"
      @submit=${async (event: Event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (button?.disabled) {
          return;
        }
        if (button) {
          button.disabled = true;
        }
        try {
          const posts = await Promise.all(
            thread.posts.map(async (post, index) => {
              const text =
                form.querySelector<HTMLTextAreaElement>(`[data-post="${index}"]`)?.value.trim() ??
                "";
              const images = (post.images ?? []).map((image, imageIndex) => ({
                data_uri: image.data_uri,
                alt_text:
                  form
                    .querySelector<HTMLInputElement>(`[data-alt="${index}-${imageIndex}"]`)
                    ?.value.trim() ?? "",
              }));
              const file = form.querySelector<HTMLInputElement>(`[data-figure="${index}"]`)
                ?.files?.[0];
              if (file) {
                images.push({
                  data_uri: await readXFigure(file),
                  alt_text:
                    form
                      .querySelector<HTMLInputElement>(`[data-new-alt="${index}"]`)
                      ?.value.trim() ?? "",
                });
              }
              return { text, ...(images.length ? { images } : {}) };
            }),
          );
          const saved = readXThreadDraft({ stage: thread.stage, posts });
          props.onSaveDraft("x", posts.map((post) => post.text).join("\n\n"), saved);
        } catch (error) {
          globalThis.alert?.((error as Error).message);
        } finally {
          if (button) {
            button.disabled = false;
          }
        }
      }}
    >
      ${thread.posts.map(
        (post, index) => html`<fieldset class="paper-cycle__post">
          <legend>
            <span>Post ${index + 1}</span
            ><span data-count=${index} .textContent=${`${xDraftLength(post.text)} / 280`}></span>
          </legend>
          <textarea
            class="input"
            rows="4"
            data-post=${index}
            aria-label=${`Post ${index + 1} text`}
            @input=${(event: Event) => {
              const input = event.currentTarget as HTMLTextAreaElement;
              const composer = input.closest(".paper-cycle__composer");
              const preview = composer?.querySelector<HTMLElement>(`[data-preview="${index}"]`);
              if (preview) {
                preview.textContent = input.value;
              }
              const count = composer?.querySelector<HTMLElement>(`[data-count="${index}"]`);
              if (count) {
                count.textContent = `${xDraftLength(input.value)} / 280`;
                count.classList.toggle("paper-cycle__over-limit", xDraftLength(input.value) > 280);
              }
            }}
            .value=${post.text}
          ></textarea>
          ${(post.images ?? []).map(
            (image, imageIndex) => html`
              <img src=${image.data_uri} alt=${image.alt_text} style="max-width:100%;height:auto" />
              <label
                >Figure description<input
                  class="input"
                  data-alt=${`${index}-${imageIndex}`}
                  .value=${image.alt_text}
                  required
                  maxlength="1000"
              /></label>
            `,
          )}
          <details class="paper-cycle__attachments">
            <summary>Add a figure</summary>
            <label
              >Reviewed paper figure (PNG/JPEG, under 512 KB)<input
                type="file"
                accept="image/png,image/jpeg"
                data-figure=${index}
            /></label>
            <label
              >New figure description<input
                class="input"
                data-new-alt=${index}
                maxlength="1000"
                placeholder="Describe the finding shown; required when adding a figure"
            /></label>
          </details>
        </fieldset>`,
      )}
      <p>
        Figures and text are saved together. Coauthor review is optional. Saving creates a new draft
        version.
      </p>
      <button class="btn primary" type="submit">Save thread and figures</button>
    </form>
    <aside class="paper-cycle__preview" aria-label="Thread preview">
      <h5>Thread preview</h5>
      <p class="paper-slot__note">Text updates as you type. Figures reflect the saved draft.</p>
      ${thread.posts.map(
        (post, index) => html`<article class="paper-cycle__preview-post">
          <span class="paper-cycle__post-number" aria-hidden="true">${index + 1}</span>
          <div>
            <strong>Paper announcement</strong>
            <p data-preview=${index} .textContent=${post.text}></p>
            ${(post.images ?? []).map(
              (image) => html`<img src=${image.data_uri} alt=${image.alt_text} />`,
            )}
          </div>
        </article>`,
      )}
    </aside>
  </div>`;
}

function renderDraft(
  props: PaperCycleProps,
  platform: string,
  stage: XAnnouncementStage = "arxiv",
) {
  // Hoisted so the click handler closes over a value that is already known to exist. Testing
  // `props.onGenerateLinkedInDraft` at the render site guards the button correctly, but the
  // narrowing does not survive into the closure, so the call read as possibly-undefined.
  const generate = platform === "x" ? props.onGenerateXDraft : props.onGenerateLinkedInDraft;
  const draft =
    platform === "x"
      ? props.drafts.find(
          (candidate) =>
            candidate.platform === "x" &&
            candidate.status !== "superseded" &&
            (candidate.x_thread?.stage ?? "arxiv") === stage,
        )
      : liveDraft(props.drafts, platform);
  const panelId = `${platform}${platform === "x" && stage !== "arxiv" ? `-${stage}` : ""}`;
  const consents = draft ? props.consents.filter((consent) => consent.draft_id === draft.id) : [];
  const waiting = consents.filter((consent) => consent.decision === "pending").length;
  return html`
    <div class="paper-cycle__draft" data-testid=${`paper-draft-${props.paperId}-${panelId}`}>
      <div class="paper-cycle__draft-head">
        <strong
          >${PLATFORM_LABELS[platform] ?? platform}
          ${platform === "x" ? X_STAGE_LABELS[stage] : "post"}</strong
        >
        ${draft
          ? html`<span
              class="paper-slot__pill ${draft.status === "approved"
                ? "paper-slot__pill--done"
                : ""}"
            >
              ${draft.status === "approved"
                ? "Approved"
                : draft.status === "circulated"
                  ? `${waiting} still to answer`
                  : platform === "x"
                    ? "Draft saved"
                    : "Not circulated"}
            </span>`
          : html`<span class="paper-slot__pill">No draft</span>`}
      </div>
      ${generate
        ? html`
            <details class="paper-cycle__draft-settings" ?open=${platform !== "x" || !draft}>
              <summary>
                ${platform === "x" ? "Source, credits and announcement details" : "Draft settings"}
              </summary>
              ${platform === "x"
                ? html`
                    <label class="paper-cycle__field"
                      ><span>Announcement stage</span>
                      <input type="hidden" data-el="x-stage" .value=${stage} />${X_STAGE_LABELS[
                        stage
                      ]}
                    </label>
                    ${stage !== "arxiv"
                      ? html`<label class="paper-cycle__field"
                          ><span>Confirmed conference</span><input class="input" data-el="x-venue"
                        /></label>`
                      : nothing}
                    ${stage === "attendance"
                      ? html`<label class="paper-cycle__field"
                          ><span>Confirmed attendees / dates</span
                          ><input class="input" data-el="x-attendees"
                        /></label>`
                      : nothing}
                    ${stage === "poster"
                      ? html`<label class="paper-cycle__field"
                          ><span>Confirmed local date/time, hall, poster number</span
                          ><input class="input" data-el="x-session"
                        /></label>`
                      : nothing}
                    ${(props.paperAuthors ?? []).map(
                      (name) => html`<label class="paper-cycle__field"
                        ><span>Confirm AdminBot identity for ${name}</span>
                        <select class="input" data-author-name=${name}>
                          <option value="">Use exact roster match; otherwise keep name</option>
                          ${(props.creditMembers ?? []).map(
                            (member) =>
                              html`<option value=${member.id}>
                                ${member.name}${member.twitter_url
                                  ? ` — ${member.twitter_url}`
                                  : " — no X handle"}
                              </option>`,
                          )}
                        </select></label
                      >`,
                    )}
                    ${Array.from(
                      new Set(
                        (props.creditMembers ?? [])
                          .map((member) => member.affiliation?.trim())
                          .filter((name): name is string => Boolean(name)),
                      ),
                    ).map(
                      (name) => html`<label class="paper-cycle__field">
                        <span
                          ><input type="checkbox" data-support-org=${name} /> Confirm support from
                          ${name}</span
                        >
                        <input
                          class="input"
                          data-org-handle=${name}
                          placeholder="Confirmed X handle (optional; otherwise use name)"
                        />
                      </label>`,
                    )}
                  `
                : nothing}
              <!-- Absorbed from the old "Draft LinkedIn post" dialog: same two optional inputs, but
                 inline where the post actually lives, so generating and circulating are one row. -->
              <label class="paper-cycle__field">
                ${platform === "x"
                  ? nothing
                  : html`
                      <span>Venue / session <em>(optional)</em></span>
                      <input
                        class="input"
                        type="text"
                        data-el="venue"
                        placeholder="ICML 2026, poster Wed Jul 8 Hall A #3015"
                      />
                    `}
              </label>
              <label class="paper-cycle__field">
                ${platform === "x"
                  ? nothing
                  : html`
                      <span>Extra context <em>(optional)</em></span>
                      <input
                        class="input"
                        type="text"
                        data-el="note"
                        placeholder="anything the abstract does not say"
                      />
                    `}
              </label>
              ${html`
                <!-- Optional, and it wins over the card's Drive copy when given: the way through
                       when the service cannot reach Drive, or the card has no file link yet. -->
                <label
                  class="logistics-upload__drop paper-cycle__pdf-drop"
                  data-testid=${`paper-draft-pdf-${props.paperId}`}
                  @dragenter=${(event: DragEvent) => {
                    event.preventDefault();
                    setPdfDragging(event, true);
                  }}
                  @dragover=${(event: DragEvent) => {
                    // Without this the browser opens the dropped PDF instead of handing it over.
                    event.preventDefault();
                    setPdfDragging(event, true);
                  }}
                  @dragleave=${(event: DragEvent) => setPdfDragging(event, false)}
                  @drop=${(event: DragEvent) => {
                    event.preventDefault();
                    setPdfDragging(event, false);
                    choosePdf(event.currentTarget as HTMLElement, event.dataTransfer?.files);
                  }}
                >
                  <span class="logistics-upload__drop-icon" aria-hidden="true"
                    >${icons.paperclip}</span
                  >
                  <span class="logistics-upload__drop-title" data-el="pdf-name"
                    >Drop the paper PDF here</span
                  >
                  <small class="logistics-upload__drop-hint"
                    >Optional — or click to choose.
                    ${platform === "x"
                      ? "Otherwise use arXiv first, then the Drive copy."
                      : "Used instead of the Drive copy on the card."}
                  </small>
                  <input
                    class="sr-only"
                    type="file"
                    accept="application/pdf,.pdf"
                    data-el="pdf"
                    @change=${(event: Event) => {
                      const input = event.currentTarget as HTMLInputElement;
                      choosePdf(input.closest("label") as HTMLElement, input.files);
                    }}
                  />
                </label>
              `}
            </details>
          `
        : nothing}
      ${draft?.x_thread
        ? renderXThreadEditor(props, draft)
        : html`<textarea
            class="input paper-cycle__draft-body"
            rows="3"
            placeholder=${`Draft the ${PLATFORM_LABELS[platform] ?? platform} post…`}
            .value=${draft?.body ?? ""}
            data-testid=${`paper-draft-body-${props.paperId}-${platform}`}
            @change=${(event: Event) => {
              const value = (event.target as HTMLTextAreaElement).value.trim();
              if (value && value !== draft?.body) {
                props.onSaveDraft(platform, value);
              }
            }}
          ></textarea>`}
      ${generate
        ? html`
            <div class="paper-cycle__draft-actions">
              <button
                type="button"
                class="btn btn--sm primary"
                data-testid=${`paper-draft-generate-${props.paperId}-${panelId}`}
                @click=${async (event: Event) => {
                  const button = event.currentTarget as HTMLButtonElement;
                  if (button.disabled) {
                    return;
                  }
                  button.disabled = true;
                  const root = (event.currentTarget as HTMLElement).closest(".paper-cycle__draft");
                  const venue =
                    root?.querySelector<HTMLInputElement>('[data-el="venue"]')?.value.trim() ?? "";
                  const note =
                    root?.querySelector<HTMLInputElement>('[data-el="note"]')?.value.trim() ?? "";
                  const pdf = root?.querySelector<HTMLInputElement>('[data-el="pdf"]')?.files?.[0];
                  try {
                    const pdfBase64 = pdf ? await readPdfBase64(pdf) : undefined;
                    if (platform === "x" && props.onGenerateXDraft) {
                      await Promise.resolve(
                        props.onGenerateXDraft(
                          venue,
                          note,
                          pdfBase64,
                          {
                            stage: (root?.querySelector<HTMLSelectElement>('[data-el="x-stage"]')
                              ?.value ?? "arxiv") as XAnnouncementDetails["stage"],
                            venue: root
                              ?.querySelector<HTMLInputElement>('[data-el="x-venue"]')
                              ?.value.trim(),
                            attendees: root
                              ?.querySelector<HTMLInputElement>('[data-el="x-attendees"]')
                              ?.value.trim(),
                            session: root
                              ?.querySelector<HTMLInputElement>('[data-el="x-session"]')
                              ?.value.trim(),
                          },
                          {
                            authors: Array.from(
                              root?.querySelectorAll<HTMLSelectElement>("[data-author-name]") ?? [],
                            )
                              .filter((select) => select.value)
                              .map((select) => ({
                                paperName: select.dataset.authorName ?? "",
                                member_id: select.value,
                              })),
                            organizations: Array.from(
                              root?.querySelectorAll<HTMLInputElement>("[data-support-org]") ?? [],
                            )
                              .filter((input) => input.checked)
                              .map((input) => {
                                const name = input.dataset.supportOrg ?? "";
                                const handle = Array.from(
                                  root?.querySelectorAll<HTMLInputElement>("[data-org-handle]") ??
                                    [],
                                )
                                  .find((field) => field.dataset.orgHandle === name)
                                  ?.value.trim();
                                return handle ? { name, x_handle: handle } : { name };
                              }),
                          },
                        ),
                      );
                    } else {
                      await Promise.resolve(generate(venue, note, pdfBase64));
                    }
                  } catch (error) {
                    globalThis.alert?.((error as Error).message);
                  } finally {
                    button.disabled = false;
                  }
                }}
              >
                Generate draft
              </button>
              ${draft?.status === "draft"
                ? html`
                    <button
                      type="button"
                      class="btn btn--sm paper-cycle__circulate"
                      data-testid=${`paper-draft-circulate-${props.paperId}-${platform}`}
                      @click=${() => props.onCirculateDraft(draft.id)}
                    >
                      ${platform === "x"
                        ? "Optional coauthor review"
                        : "Send to coauthors for sign-off"}
                    </button>
                  `
                : nothing}
            </div>
          `
        : nothing}
      ${!generate && platform !== "linkedin" && draft?.status === "draft"
        ? html`
            <button
              type="button"
              class="btn btn--sm paper-cycle__circulate"
              data-testid=${`paper-draft-circulate-${props.paperId}-${platform}`}
              @click=${() => props.onCirculateDraft(draft.id)}
            >
              ${platform === "x" ? "Optional coauthor review" : "Send to coauthors for sign-off"}
            </button>
          `
        : nothing}
      ${consents.length
        ? html`<ul class="paper-cycle__consents">
            ${consents.map((consent) => renderConsentRow(props, consent))}
          </ul>`
        : draft?.status === "circulated"
          ? html`<p class="paper-slot__note">
              No coauthors on the roster to ask, so this is approved as it stands.
            </p>`
          : nothing}
    </div>
  `;
}

function renderAttendees(props: PaperCycleProps) {
  return html`
    <details class="paper-cycle__group">
      <summary class="paper-slots__group-head">
        <h4 class="paper-slots__group-title">
          <span class="paper-slots__group-icon" aria-hidden="true">${icons.user}</span>
          Who is going
        </h4>
        <span class="paper-slots__group-chevron" aria-hidden="true">${icons.chevronDown}</span>
      </summary>
      ${props.attendees.length
        ? html`<ul class="paper-cycle__rows">
            ${props.attendees.map(
              (attendee) => html`
                <li class="paper-cycle__row">
                  <span>${attendee.name}</span>
                  <select
                    class="input"
                    data-testid=${`paper-attendee-${props.paperId}-${attendee.attendee_key}`}
                    @change=${(event: Event) =>
                      props.onSetAttendee(
                        attendee.name,
                        attendee.member_id,
                        (event.target as HTMLSelectElement).value,
                      )}
                  >
                    ${["yes", "no", "unknown"].map(
                      (state) => html`
                        <option value=${state} ?selected=${state === attendee.attending}>
                          ${ATTENDING_LABELS[state]}
                        </option>
                      `,
                    )}
                  </select>
                </li>
              `,
            )}
          </ul>`
        : html`<p class="paper-slot__note">Nobody added yet.</p>`}
      <form
        class="paper-cycle__add"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          const name = String(new FormData(form).get("name") ?? "").trim();
          if (name) {
            props.onSetAttendee(name, undefined, "unknown");
            form.reset();
          }
        }}
      >
        <input
          class="input"
          name="name"
          placeholder="Add an author"
          data-testid=${`paper-attendee-add-${props.paperId}`}
        />
        <button type="submit" class="btn btn--sm">Add</button>
      </form>
    </details>
  `;
}

/** One member's own plan for the conference this paper was accepted to. */
export type PaperTrip = {
  conference_key: string;
  member_id: string;
  intent: "going" | "undecided";
  funding: "none" | "fee_only" | "flight_only" | "full_travel";
  needs_lodging: boolean;
  arrival_on?: string;
  departure_on?: string;
  needs_visa_letter: boolean;
  notes?: string;
};

export type PaperTripDraft = {
  intent: PaperTrip["intent"];
  funding: PaperTrip["funding"];
  needs_lodging: boolean;
  needs_visa_letter: boolean;
  arrival_on: string;
  departure_on: string;
  notes: string;
};

const TRIP_INTENT_LABELS: Record<PaperTrip["intent"], string> = {
  going: "I'm going in person",
  undecided: "Still deciding",
};

/**
 * The four funding buckets, in what they cost the lab.
 *
 * "No financial aid needed" is offered explicitly rather than left as the blank default: somebody
 * funded by their own scholarship and somebody who has not answered look identical otherwise, and
 * the difference between them is a plane ticket.
 */
const TRIP_FUNDING_LABELS: Record<PaperTrip["funding"], string> = {
  none: "No financial aid needed",
  fee_only: "Conference fee only",
  flight_only: "Flight only",
  full_travel: "Full travel (fee, flights and accommodation)",
};

export function paperTripDraftFrom(trip: PaperTrip | null | undefined): PaperTripDraft {
  return {
    // Undecided rather than going: a form that opens on "yes" collects agreement rather than an
    // answer, and this one books flights.
    intent: trip?.intent ?? "undecided",
    funding: trip?.funding ?? "none",
    needs_lodging: trip?.needs_lodging ?? false,
    needs_visa_letter: trip?.needs_visa_letter ?? false,
    arrival_on: trip?.arrival_on ?? "",
    departure_on: trip?.departure_on ?? "",
    notes: trip?.notes ?? "",
  };
}

/**
 * What the reader needs for this conference: money, a bed, a visa letter.
 *
 * On the paper card rather than a conference page of its own, because the paper is what somebody
 * is looking at when they find out they are going somewhere. It sits under "Who is going" for the
 * same reason: that block records who travels, and this one records what their travel needs.
 *
 * Keyed by conference, not by paper. Somebody with three accepted papers at one venue takes one
 * trip, so answering here fills the block in on the other two cards as well.
 */
function renderMyTrip(props: PaperCycleProps) {
  if (!props.onSaveTrip || !props.onEditTrip) {
    return nothing;
  }
  const draft = props.tripDraft ?? paperTripDraftFrom(props.myTrip);
  const edit = props.onEditTrip;
  const going = draft.intent === "going";
  return html`
    <details class="paper-cycle__group">
      <summary class="paper-slots__group-head">
        <h4 class="paper-slots__group-title">
          <span class="paper-slots__group-icon" aria-hidden="true">${icons.globe}</span>
          What you need for this trip
        </h4>
        <span class="paper-slots__group-chevron" aria-hidden="true">${icons.chevronDown}</span>
      </summary>
      <p class="paper-slot__note">
        Your own answer, for the whole conference rather than this one paper. The lab books against
        it — headcount, nights and who needs what covered.
      </p>
      <div class="paper-trip">
        <label class="paper-trip__field">
          <span>Are you going?</span>
          <select
            class="input"
            data-testid=${`paper-trip-intent-${props.paperId}`}
            @change=${(event: Event) =>
              edit({ intent: (event.target as HTMLSelectElement).value as PaperTrip["intent"] })}
          >
            ${(Object.keys(TRIP_INTENT_LABELS) as PaperTrip["intent"][]).map(
              (value) => html`<option value=${value} ?selected=${value === draft.intent}>
                ${TRIP_INTENT_LABELS[value]}
              </option>`,
            )}
          </select>
        </label>
        ${going
          ? html`
              <label class="paper-trip__field">
                <span>What do you need the lab to cover?</span>
                <select
                  class="input"
                  data-testid=${`paper-trip-funding-${props.paperId}`}
                  @change=${(event: Event) =>
                    edit({
                      funding: (event.target as HTMLSelectElement).value as PaperTrip["funding"],
                    })}
                >
                  ${(Object.keys(TRIP_FUNDING_LABELS) as PaperTrip["funding"][]).map(
                    (value) => html`<option value=${value} ?selected=${value === draft.funding}>
                      ${TRIP_FUNDING_LABELS[value]}
                    </option>`,
                  )}
                </select>
              </label>
              <label class="paper-trip__check">
                <input
                  type="checkbox"
                  data-testid=${`paper-trip-lodging-${props.paperId}`}
                  .checked=${draft.needs_lodging}
                  @change=${(event: Event) =>
                    edit({ needs_lodging: (event.target as HTMLInputElement).checked })}
                />
                <span
                  >I want a bed in whatever the lab books
                  <small
                    >Asked separately from the money: you might need no funding and still want to
                    stay with everyone.</small
                  ></span
                >
              </label>
              ${draft.needs_lodging
                ? html`
                    <!-- Both dates: a headcount alone books the wrong thing. The lab needs how
                         many beds *and* for which nights. -->
                    <label class="paper-trip__field">
                      <span>Arriving</span>
                      ${renderDateControl(
                        html`<input
                          class="input"
                          type="date"
                          data-testid=${`paper-trip-arrival-${props.paperId}`}
                          .value=${draft.arrival_on}
                          @input=${(event: Event) =>
                            edit({ arrival_on: (event.target as HTMLInputElement).value })}
                        />`,
                        draft.arrival_on,
                      )}
                    </label>
                    <label class="paper-trip__field">
                      <span>Leaving</span>
                      ${renderDateControl(
                        html`<input
                          class="input"
                          type="date"
                          data-testid=${`paper-trip-departure-${props.paperId}`}
                          .value=${draft.departure_on}
                          @input=${(event: Event) =>
                            edit({ departure_on: (event.target as HTMLInputElement).value })}
                        />`,
                        draft.departure_on,
                      )}
                    </label>
                  `
                : nothing}
              <label class="paper-trip__check">
                <input
                  type="checkbox"
                  data-testid=${`paper-trip-visa-${props.paperId}`}
                  .checked=${draft.needs_visa_letter}
                  @change=${(event: Event) =>
                    edit({ needs_visa_letter: (event.target as HTMLInputElement).checked })}
                />
                <span
                  >I need a visa invitation letter
                  <small>Say so early — these take weeks to arrange.</small></span
                >
              </label>
              <label class="paper-trip__field">
                <span>Anything else</span>
                <textarea
                  class="input"
                  rows="2"
                  placeholder="Arriving early for a workshop, sharing a room, funded by my scholarship…"
                  data-testid=${`paper-trip-notes-${props.paperId}`}
                  .value=${draft.notes}
                  @input=${(event: Event) =>
                    edit({ notes: (event.target as HTMLTextAreaElement).value })}
                ></textarea>
              </label>
            `
          : nothing}
        <div class="paper-trip__actions">
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${props.tripSaving}
            data-testid=${`paper-trip-save-${props.paperId}`}
            @click=${() => props.onSaveTrip?.()}
          >
            ${props.tripSaving ? "Saving…" : props.myTrip ? "Update" : "Save"}
          </button>
          ${props.myTrip
            ? html`<button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${props.tripSaving}
                  data-testid=${`paper-trip-withdraw-${props.paperId}`}
                  @click=${() => props.onWithdrawTrip?.()}
                >
                  I'm not going after all
                </button>
                <span class="paper-slot__note">Recorded.</span>`
            : nothing}
        </div>
      </div>
    </details>
  `;
}

/**
 * Reimbursements, and the sentence that says whether the paper is finished.
 *
 * Only people recorded as going appear: a reimbursement row for somebody who stayed home is a
 * question with no answer, and it would hold the cycle open forever.
 */
function renderReimbursements(props: PaperCycleProps) {
  const going = props.attendees.filter(
    (attendee) => attendee.attending === "yes" && attendee.member_id,
  );
  if (going.length === 0) {
    return nothing;
  }
  const byMember = new Map(props.reimbursements.map((row) => [row.member_id, row]));
  return html`
    <details class="paper-cycle__group">
      <summary class="paper-slots__group-head">
        <h4 class="paper-slots__group-title">
          <span class="paper-slots__group-icon" aria-hidden="true">${icons.wrench}</span>
          Reimbursements
        </h4>
        <span class="paper-slots__group-chevron" aria-hidden="true">${icons.chevronDown}</span>
      </summary>
      <ul class="paper-cycle__rows">
        ${going.map((attendee) => {
          const memberId = attendee.member_id as string;
          const status = byMember.get(memberId)?.status ?? "pending";
          return html`
            <li class="paper-cycle__row">
              <span>${attendee.name}</span>
              <select
                class="input"
                data-testid=${`paper-reimbursement-${props.paperId}-${memberId}`}
                @change=${(event: Event) =>
                  props.onSetReimbursement(memberId, (event.target as HTMLSelectElement).value)}
              >
                ${Object.entries(REIMBURSEMENT_LABELS).map(
                  ([value, label]) => html`
                    <option value=${value} ?selected=${value === status}>${label}</option>
                  `,
                )}
              </select>
            </li>
          `;
        })}
      </ul>
      <p class="paper-slot__note">
        Everyone who travelled being square is what closes this paper — not somebody deciding it
        looks finished.
      </p>
    </details>
  `;
}

export function renderPaperCycle(props: PaperCycleProps) {
  return html`
    <div class="paper-cycle" data-testid=${`paper-cycle-${props.paperId}`}>
      <details class="paper-cycle__group" id=${`paper-social-drafts-${props.paperId}`}>
        <summary class="paper-slots__group-head">
          <h4 class="paper-slots__group-title">
            <span class="paper-slots__group-icon" aria-hidden="true">${icons.globe}</span>
            Social drafts
          </h4>
          <span class="paper-slots__group-chevron" aria-hidden="true">${icons.chevronDown}</span>
        </summary>
        <p class="paper-slot__note">
          Stored so the coauthors named in a post can be shown it before it goes out.
        </p>
        ${props.onGenerateXDraft
          ? html`<div class="paper-cycle__stage-picker">
              <label class="paper-cycle__field"
                ><span>What would you like to announce?</span>
                <select
                  class="input"
                  aria-label="Announcement to make"
                  @change=${(event: Event) => {
                    const select = event.currentTarget as HTMLSelectElement;
                    const root = select.closest(".paper-cycle__stage-picker");
                    root
                      ?.querySelectorAll<HTMLElement>("[data-announcement-panel]")
                      .forEach((panel) => {
                        panel.hidden = panel.dataset.announcementPanel !== select.value;
                      });
                  }}
                >
                  ${X_ANNOUNCEMENT_STAGES.map(
                    (stage) => html`<option value=${stage}>${X_STAGE_LABELS[stage]}</option>`,
                  )}
                </select>
              </label>
              <p class="paper-slot__note">
                Each announcement has its own template and saved thread for this paper.
              </p>
              ${X_ANNOUNCEMENT_STAGES.map(
                (stage) => html`<section
                  data-announcement-panel=${stage}
                  .hidden=${stage !== "arxiv"}
                >
                  <p class="paper-slot__note">
                    ${{
                      arxiv: "Hook → method and findings → significance, paper link and credits.",
                      acceptance:
                        "Acceptance hook → contribution and findings → significance, venue, paper link and credits.",
                      attendance: "Who is going → confirmed dates → invitation to meet.",
                      poster:
                        "Come chat → confirmed local time and poster location → topic and paper link.",
                    }[stage]}
                  </p>
                  ${renderDraft(props, "x", stage)}
                </section>`,
              )}
            </div>`
          : renderDraft(props, "x")}
        ${renderDraft(props, "linkedin")}
      </details>

      ${props.missingAcceptanceDetails.length
        ? html`<p class="paper-cycle__blocked">
            The venue accepted this — record the ${props.missingAcceptanceDetails.join(", ")} above
            and the conference section opens.
          </p>`
        : nothing}
      ${props.conferenceOpen ? renderAttendees(props) : nothing}
      ${props.conferenceOpen ? renderMyTrip(props) : nothing}
      ${props.conferenceOpen ? renderReimbursements(props) : nothing}
      ${props.cycleClosed
        ? html`<p class="paper-cycle__closed">
            ${icons.check} Everything on this paper is finished, expenses included.
          </p>`
        : nothing}
    </div>
  `;
}
