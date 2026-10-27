import { html, nothing } from "lit";
import {
  X_ANNOUNCEMENT_STAGES,
  readXThreadDraft,
  renumberXThread,
  xDraftLength,
  xThreadFromText,
  type XAnnouncementDetails,
  type XAnnouncementStage,
  type XCreditSelection,
} from "../../../../../extensions/adminbot/src/workflows/papers/x-draft.js";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type {
  PaperAttendee,
  PaperReimbursement,
  PaperSocialConsent,
  PaperSocialDraft,
} from "../api/papers.ts";
// The parts of a paper card that are lists rather than single fields: the social drafts and who
// has signed off on them, who is going to the conference, and who has been reimbursed.
//
// Kept apart from the slot checklist above it because they behave differently. A slot is one
// answer with one owner; each of these is a set of rows about several people, and the useful
// question is "who has not answered yet" rather than "is it filled in".

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
  /** The conference as the card records it ("EMNLP 2026 (Oral)"), prefilled into the settings. */
  defaultVenue?: string;
  onSaveDraft: (
    platform: string,
    body: string,
    xThread?: import("../../../../../extensions/adminbot/src/workflows/papers/x-draft.js").XThreadDraft,
  ) => void;
  onCirculateDraft: (draftId: string) => void;
  /**
   * LinkedIn only: run the model draft with the panel's venue/context inputs and store the text.
   * `pdfBase64` is a PDF dropped on the panel; absent, the service reads the card's arXiv or Drive
   * copy. `abstract` is pasted by hand for a paper with neither, and replaces PDF reading.
   * May return the request's promise: the panel awaits it to keep its button disabled meanwhile.
   */
  onGenerateLinkedInDraft?: (
    venue: string,
    note: string,
    pdfBase64?: string,
    abstract?: string,
  ) => unknown;
  onGenerateXDraft?: (
    venue: string,
    note: string,
    pdfBase64?: string,
    announcement?: XAnnouncementDetails,
    credits?: XCreditSelection,
    abstract?: string,
  ) => unknown;
  onConsent: (draftId: string, decision: string, comment?: string) => void;
  onSetAttendee: (name: string, memberId: string | undefined, attending: string) => void;
  /**
   * The reader's own answer for this paper's conference, read back, and the way to the Travel tab
   * where it is given.
   *
   * Optional: a surface with no `onOpenTravel` draws nothing. Active Papers reuses this renderer
   * over other people's papers, and "are *you* going" is not a question for somebody else's card.
   */
  myTrip?: PaperTrip | null;
  onOpenTravel?: () => void;
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
    globalThis.alert?.(
      isPdf(file)
        ? "That PDF is over 20 MB. Leave it out to use the arXiv or Drive copy, or paste the abstract instead."
        : `${file.name} is not a PDF. Drop the paper PDF, or paste the abstract instead.`,
    );
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
  poster: "Poster or talk — come chat",
};

/** The service's per-figure ceiling: a data URI of 700,000 characters is about 512 KB of image. */
const X_FIGURE_MAX_DATA_URI = 690_000;

function readDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error(`Could not read "${file.name}".`)),
    );
    reader.addEventListener("error", () => reject(new Error(`Could not read "${file.name}".`)));
    reader.readAsDataURL(file);
  });
}

/**
 * A figure as X will take it.
 *
 * A screenshot of a results table is routinely a 2 MB PNG, and "choose a figure under 512 KB" sent
 * people off to an image editor. Anything too big, or in another format (WebP, HEIC from a phone),
 * is redrawn as a JPEG and shrunk until it fits; only a figure that cannot be shrunk enough is
 * refused, and the message says what to do.
 */
export async function readXFigure(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error(`"${file.name}" is not an image. Choose a PNG or JPEG figure.`);
  }
  const original = await readDataUri(file);
  if (/^image\/(png|jpeg)$/u.test(file.type) && original.length <= X_FIGURE_MAX_DATA_URI) {
    return original;
  }
  const image = new Image();
  image.src = original;
  try {
    await image.decode();
  } catch {
    throw new Error(`"${file.name}" could not be opened as an image. Export it as PNG or JPEG.`);
  }
  let scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight, 1));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      break;
    }
    // JPEG has no transparency; white is what a transparent plot background looks like on X.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const shrunk = canvas.toDataURL("image/jpeg", 0.85);
    if (shrunk.length <= X_FIGURE_MAX_DATA_URI) {
      return shrunk;
    }
    scale *= 0.75;
  }
  throw new Error(
    `"${file.name}" is still over 512 KB after shrinking. Crop it to the part that matters and try again.`,
  );
}

async function copyToClipboard(text: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = label;
    }, 1500);
  } catch {
    globalThis.alert?.("The browser blocked copying. Select the text and copy it by hand.");
  }
}

/** The thread as currently typed, so copying gives what is on screen rather than the last save. */
function currentThreadText(composer: Element | null, fallback: string[]): string[] {
  return fallback.map(
    (text, index) =>
      composer?.querySelector<HTMLTextAreaElement>(`[data-post="${index}"]`)?.value.trim() ?? text,
  );
}

function renderXThreadEditor(props: PaperCycleProps, draft: PaperSocialDraft) {
  const thread = draft.x_thread;
  if (!thread) {
    return nothing;
  }
  return html`<div class="paper-cycle__composer">
    <form
      class="paper-cycle__thread"
      novalidate
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
          const edited = await Promise.all(
            thread.posts.map(async (post, index) => {
              const label = `Post ${index + 1}`;
              const text =
                form.querySelector<HTMLTextAreaElement>(`[data-post="${index}"]`)?.value.trim() ??
                "";
              const images = (post.images ?? []).flatMap((image, imageIndex) => {
                if (
                  form.querySelector<HTMLInputElement>(`[data-remove="${index}-${imageIndex}"]`)
                    ?.checked
                ) {
                  return [];
                }
                const alt =
                  form
                    .querySelector<HTMLInputElement>(`[data-alt="${index}-${imageIndex}"]`)
                    ?.value.trim() ?? "";
                if (!alt) {
                  throw new Error(
                    `${label}, figure ${imageIndex + 1} needs a description, or tick "Remove this figure".`,
                  );
                }
                return [{ data_uri: image.data_uri, alt_text: alt }];
              });
              const file = form.querySelector<HTMLInputElement>(`[data-figure="${index}"]`)
                ?.files?.[0];
              if (file) {
                const alt =
                  form.querySelector<HTMLInputElement>(`[data-new-alt="${index}"]`)?.value.trim() ??
                  "";
                if (!alt) {
                  throw new Error(
                    `${label}: describe the new figure in one sentence (it is read aloud to screen-reader users), or clear the file.`,
                  );
                }
                if (images.length >= 4) {
                  throw new Error(`${label} already has four figures, the most X allows.`);
                }
                images.push({ data_uri: await readXFigure(file), alt_text: alt });
              }
              return { text, ...(images.length ? { images } : {}) };
            }),
          );
          const added = form.querySelector<HTMLTextAreaElement>("[data-post-new]")?.value ?? "";
          const posts = renumberXThread([...edited, ...xThreadFromText(added)]);
          if (!posts.length) {
            throw new Error("Every post is empty. Write at least one post before saving.");
          }
          const saved = readXThreadDraft({ stage: thread.stage, posts });
          props.onSaveDraft("x", saved.posts.map((post) => post.text).join("\n\n"), saved);
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
                const length = xDraftLength(input.value);
                count.textContent =
                  length > 280 ? `${length} / 280 — will be split on save` : `${length} / 280`;
                count.classList.toggle("paper-cycle__over-limit", length > 280);
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
                  maxlength="1000"
              /></label>
              <label
                ><input type="checkbox" data-remove=${`${index}-${imageIndex}`} /> Remove this
                figure</label
              >
            `,
          )}
          <details class="paper-cycle__attachments">
            <summary>Add a figure</summary>
            <label
              >Paper figure (PNG/JPEG; larger images are shrunk to fit)<input
                type="file"
                accept="image/*"
                data-figure=${index}
            /></label>
            <label
              >New figure description<input
                class="input"
                data-new-alt=${index}
                maxlength="1000"
                placeholder="One sentence on what the figure shows; needed only if you add one"
            /></label>
          </details>
        </fieldset>`,
      )}
      <label class="paper-cycle__field"
        ><span>Add posts <em>(optional)</em></span
        ><textarea
          class="input"
          rows="2"
          data-post-new
          placeholder="Another post. Leave a blank line between posts to add several."
        ></textarea>
      </label>
      <p>
        To remove a post, clear its text. Posts over 280 characters are split, and numbering is
        redone, when you save. Coauthor review is optional. Saving creates a new draft version.
      </p>
      <button class="btn primary" type="submit">Save thread and figures</button>
    </form>
    <aside class="paper-cycle__preview" aria-label="Thread preview">
      <h5>Thread preview</h5>
      <p class="paper-slot__note">
        Text updates as you type. Figures reflect the saved draft. Post by hand on X: copy each post
        into the composer, attaching its figures.
      </p>
      <button
        type="button"
        class="btn btn--sm"
        data-testid=${`paper-draft-copy-thread-${props.paperId}`}
        @click=${(event: Event) => {
          const button = event.currentTarget as HTMLButtonElement;
          const texts = currentThreadText(
            button.closest(".paper-cycle__composer"),
            thread.posts.map((post) => post.text),
          );
          void copyToClipboard(texts.filter(Boolean).join("\n\n"), button);
        }}
      >
        Copy whole thread
      </button>
      ${thread.posts.map(
        (post, index) => html`<article class="paper-cycle__preview-post">
          <span class="paper-cycle__post-number" aria-hidden="true">${index + 1}</span>
          <div>
            <strong>Paper announcement</strong>
            <p data-preview=${index} .textContent=${post.text}></p>
            ${(post.images ?? []).map(
              (image) => html`<img src=${image.data_uri} alt=${image.alt_text} />`,
            )}
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`paper-draft-copy-post-${props.paperId}-${index}`}
              @click=${(event: Event) => {
                const button = event.currentTarget as HTMLButtonElement;
                const live =
                  button
                    .closest(".paper-cycle__composer")
                    ?.querySelector<HTMLTextAreaElement>(`[data-post="${index}"]`)
                    ?.value.trim() ?? post.text;
                void copyToClipboard(live, button);
              }}
            >
              Copy post ${index + 1}
            </button>
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
  // Whether this panel can generate at all. The click handler calls the platform's own callback
  // with `?.`: the two take different trailing arguments, so the union cannot be called directly.
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
            <details class="paper-cycle__draft-settings">
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
                          ><span>Confirmed conference</span
                          ><input
                            class="input"
                            data-el="x-venue"
                            .value=${props.defaultVenue ?? ""}
                            placeholder="EMNLP 2026 (Oral)"
                        /></label>`
                      : nothing}
                    ${stage === "attendance"
                      ? html`<label class="paper-cycle__field"
                          ><span>Confirmed attendees / dates</span
                          ><input
                            class="input"
                            data-el="x-attendees"
                            placeholder="Mina and Khai, Nov 4–8"
                        /></label>`
                      : nothing}
                    ${stage === "poster"
                      ? html`<label class="paper-cycle__field"
                          ><span>Confirmed local date/time, room, poster number or talk slot</span
                          ><input
                            class="input"
                            data-el="x-session"
                            placeholder="Wed Nov 5, 14:00, Hall B poster #212 — or Oral session 3A, Room 101"
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
                        .value=${props.defaultVenue ?? ""}
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
                      ? "Without one: the arXiv copy, then the Drive copy, then the abstract below."
                      : "Without one: the Drive copy, then arXiv, then the abstract below."}
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
                <label class="paper-cycle__field"
                  ><span
                    >Abstract
                    <em>(optional — paste it if the paper has no PDF or arXiv link)</em></span
                  ><textarea
                    class="input"
                    rows="3"
                    data-el="abstract"
                    placeholder="The whole abstract. Used only when no PDF is dropped above."
                  ></textarea>
                </label>
              `}
            </details>
          `
        : nothing}
      ${draft?.x_thread
        ? renderXThreadEditor(props, draft)
        : html`<textarea
              class="input paper-cycle__draft-body"
              rows=${platform === "x" ? 6 : 3}
              placeholder=${platform === "x"
                ? "Write the thread by hand, or press Generate. Leave a blank line between posts; long posts are split and numbered on save."
                : `Draft the ${PLATFORM_LABELS[platform] ?? platform} post…`}
              .value=${draft?.body ?? ""}
              data-testid=${`paper-draft-body-${props.paperId}-${platform}`}
              @change=${(event: Event) => {
                const value = (event.target as HTMLTextAreaElement).value.trim();
                if (!value || value === draft?.body) {
                  return;
                }
                if (platform !== "x") {
                  props.onSaveDraft(platform, value);
                  return;
                }
                // Typed text becomes a real thread for this panel's stage, so it gets the post
                // editor, the 280-character check and the copy buttons, and lands on this stage.
                try {
                  const thread = readXThreadDraft({ stage, posts: xThreadFromText(value) });
                  props.onSaveDraft(
                    platform,
                    thread.posts.map((post) => post.text).join("\n\n"),
                    thread,
                  );
                } catch (error) {
                  globalThis.alert?.((error as Error).message);
                }
              }}
            ></textarea>
            ${draft?.body
              ? html`<button
                  type="button"
                  class="btn btn--sm"
                  data-testid=${`paper-draft-copy-${props.paperId}-${panelId}`}
                  @click=${(event: Event) => {
                    const button = event.currentTarget as HTMLButtonElement;
                    const text =
                      button
                        .closest(".paper-cycle__draft")
                        ?.querySelector<HTMLTextAreaElement>(".paper-cycle__draft-body")
                        ?.value.trim() ?? draft.body;
                    void copyToClipboard(text, button);
                  }}
                >
                  Copy post
                </button>`
              : nothing}`}
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
                  const abstract =
                    root
                      ?.querySelector<HTMLTextAreaElement>('[data-el="abstract"]')
                      ?.value.trim() || undefined;
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
                          abstract,
                        ),
                      );
                    } else {
                      await Promise.resolve(
                        props.onGenerateLinkedInDraft?.(venue, note, pdfBase64, abstract),
                      );
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

/**
 * Where to say you are going: the Travel tab.
 *
 * This card used to carry the whole trip form -- going or not, funding, the lab's shared
 * accommodation, a visa letter. It moved to the Travel tab, which lists every upcoming conference
 * by site whether or not you have a paper there, so there is one place to RSVP rather than one per
 * paper. What stays here is the reader's answer, read back, and the way to change it.
 */
function renderTravelPointer(props: PaperCycleProps) {
  if (!props.onOpenTravel) {
    return nothing;
  }
  const trip = props.myTrip;
  const status = !trip
    ? t("labTravel.paperCard.none")
    : trip.intent === "going"
      ? trip.needs_lodging
        ? t("labTravel.paperCard.goingAirbnb")
        : t("labTravel.paperCard.going")
      : t("labTravel.paperCard.undecided");
  return html`
    <div class="paper-cycle__travel" data-testid=${`paper-travel-${props.paperId}`}>
      <span class="paper-slots__group-icon" aria-hidden="true">${icons.mapPin}</span>
      <span>${status}</span>
      <button
        type="button"
        class="btn btn--sm"
        data-testid=${`paper-travel-open-${props.paperId}`}
        @click=${() => props.onOpenTravel?.()}
      >
        ${trip ? t("labTravel.paperCard.change") : t("labTravel.paperCard.rsvp")}
      </button>
    </div>
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
      ${props.conferenceOpen ? renderTravelPointer(props) : nothing}
      ${props.conferenceOpen ? renderReimbursements(props) : nothing}
      ${props.cycleClosed
        ? html`<p class="paper-cycle__closed">
            ${icons.check} Everything on this paper is finished, expenses included.
          </p>`
        : nothing}
    </div>
  `;
}
