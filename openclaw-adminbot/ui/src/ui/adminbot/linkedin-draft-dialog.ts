// "Draft the LinkedIn post" — the Social step's working surface.
//
// Deliberately stores nothing. The draft lives in this dialog until it is copied, and closing
// the dialog throws it away. That is the design, not a limitation: the authoritative version of
// the post is the one on LinkedIn, and a saved copy would only ever be the stale one.
//
// Built imperatively rather than as a Lit view, for the same reason paperflow-map.ts is: it owns
// a <dialog>, a file reader and a clipboard call — state that belongs to the overlay and dies
// with it.
//
// ── Why there is no "post it for me" button ────────────────────────────────────────────────
// LinkedIn creates a real @mention only from `@[Name](urn:li:person:…)` sent through its Posts
// API. Pasted into the web composer, that syntax renders as literal characters — brackets,
// parens and all. So the copy button copies clean text, and tagging is handled the only way it
// can be from a paste: by telling the author exactly who to @-type, and handing them the
// profile to check they picked the right person.

import {
  draftLinkedInPost,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  type LinkedInDraft,
  type LinkedInDraftAuthor,
} from "./auth/session.ts";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";
import type { UiSettings } from "../storage.ts";

const MAX_PDF_BYTES = 20 * 1024 * 1024;

export type LinkedInDraftDialogDeps = {
  settings?: Pick<UiSettings, "adminBotUrl"> | null;
};

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read the file"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      // Strip the "data:application/pdf;base64," prefix; the API wants the payload only.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** Authors we can tag, those we cannot, and why — the panel that makes a pasted post taggable. */
function renderMentions(authors: LinkedInDraftAuthor[]): string {
  if (authors.length === 0) {
    return "";
  }
  const rows = authors
    .map((author) => {
      const name = escapeHtml(author.displayName);
      if (author.linkedin_urn || author.linkedin_url) {
        const link = author.linkedin_url
          ? `<a href="${escapeHtml(author.linkedin_url)}" target="_blank" rel="noreferrer noopener">profile</a>`
          : "<span class='lidraft__muted'>no profile link</span>";
        const warn =
          author.match === "initial"
            ? " <span class='lidraft__warn' title='Matched on surname and first initial only — check this is the right person.'>⚠ weak match</span>"
            : "";
        return `<li><button type="button" class="btn btn--sm lidraft__copy-name" data-name="${name}">Copy “${name}”</button> ${link}${warn}</li>`;
      }
      return `<li class="lidraft__muted">${name} — not in the roster, left as plain text</li>`;
    })
    .join("");
  return `
    <div class="lidraft__mentions">
      <strong>Tagging</strong>
      <p class="lidraft__hint">
        Pasting cannot create mentions — LinkedIn only makes them when you type <code>@</code> in
        its composer and pick from the dropdown. Copy a name, type <code>@</code>, paste, then
        choose the match. The profile link is there to check you picked the right person.
      </p>
      <ul class="lidraft__mention-list">${rows}</ul>
    </div>`;
}

export function openLinkedInDraftDialog(
  paper: AdminBotPaperRecord,
  deps: LinkedInDraftDialogDeps = {},
): void {
  // The member's own session, the same one every other paper write uses. Without it there is
  // nobody to authorize the call, so say so rather than opening a dialog that cannot work.
  const stored = loadStoredMemberSession();
  const baseUrl = resolveAdminBotBaseUrl(deps.settings);
  const dialog = document.createElement("dialog");
  dialog.className = "lidraft";
  dialog.innerHTML = `
    <div class="lidraft__bar">
      <div>
        <strong>Draft the LinkedIn post</strong>
        <span class="lidraft__subtitle">${escapeHtml(paper.title)}</span>
      </div>
      <button type="button" class="btn btn--sm" data-act="close">Close</button>
    </div>

    <div class="lidraft__body">
      <div class="lidraft__inputs">
        <label class="lidraft__field">
          <span>Paper PDF</span>
          <input type="file" accept="application/pdf,.pdf" data-el="pdf" />
        </label>
        <label class="lidraft__field">
          <span>Venue / session <em>(optional)</em></span>
          <input type="text" data-el="venue" placeholder="ICML 2026, poster Wed Jul 8 Hall A #3015" />
        </label>
        <label class="lidraft__field">
          <span>Extra context <em>(optional)</em></span>
          <input type="text" data-el="note" placeholder="anything the abstract does not say" />
        </label>
        <button type="button" class="btn primary" data-act="generate">Generate draft</button>
        <div class="lidraft__progress" data-el="progress" hidden>
          <div class="lidraft__bar-track"><div class="lidraft__bar-fill"></div></div>
          <p class="lidraft__hint">
            <span data-el="phase">Reading the PDF…</span>
            <span class="lidraft__elapsed" data-el="elapsed"></span>
          </p>
        </div>
        <p class="lidraft__hint" data-el="status"></p>
      </div>

      <div class="lidraft__output" data-el="output" hidden>
        <div class="lidraft__meta">
          <span data-el="count"></span>
          <span data-el="model" class="lidraft__muted"></span>
        </div>
        <div class="lidraft__issues" data-el="issues" hidden></div>
        <textarea data-el="text" rows="18" spellcheck="true"></textarea>
        <div class="lidraft__actions">
          <button type="button" class="btn primary" data-act="copy">Copy post</button>
          <button type="button" class="btn btn--sm" data-act="regen">Regenerate</button>
          <span class="lidraft__muted" data-el="copied"></span>
        </div>
        <div data-el="mentions"></div>
      </div>
    </div>
    <p class="lidraft__hint lidraft__footnote">
      Nothing here is saved. Close this and the draft is gone.
    </p>
  `;
  document.body.appendChild(dialog);
  dialog.showModal();

  const el = <T extends HTMLElement>(name: string) =>
    dialog.querySelector<T>(`[data-el="${name}"]`);
  const pdfInput = el<HTMLInputElement>("pdf");
  const venueInput = el<HTMLInputElement>("venue");
  const noteInput = el<HTMLInputElement>("note");
  const status = el<HTMLElement>("status");
  const output = el<HTMLElement>("output");
  const textArea = el<HTMLTextAreaElement>("text");
  const countEl = el<HTMLElement>("count");
  const modelEl = el<HTMLElement>("model");
  const issuesEl = el<HTMLElement>("issues");
  const mentionsEl = el<HTMLElement>("mentions");
  const copiedEl = el<HTMLElement>("copied");
  const progressEl = el<HTMLElement>("progress");
  const phaseEl = el<HTMLElement>("phase");
  const elapsedEl = el<HTMLElement>("elapsed");
  const generateButton = dialog.querySelector<HTMLButtonElement>('[data-act="generate"]');

  // A 20-second wait with no moving parts reads as a hang, so the bar animates and the elapsed
  // counter ticks. The phase label is time-based rather than reported by the server: the request
  // is a single round trip, but extraction reliably dominates the first half, so naming it is
  // more informative than a bare spinner. It never claims to be finished.
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopProgress = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (progressEl) {
      progressEl.hidden = true;
    }
    if (generateButton) {
      generateButton.disabled = false;
    }
  };

  const startProgress = () => {
    const startedAt = Date.now();
    if (progressEl) {
      progressEl.hidden = false;
    }
    if (generateButton) {
      generateButton.disabled = true;
    }
    const tick = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsedEl) {
        elapsedEl.textContent = `${seconds}s`;
      }
      if (phaseEl) {
        phaseEl.textContent =
          seconds < 10 ? "Reading the PDF…" : "Writing the post in the lab's voice…";
      }
    };
    tick();
    timer = setInterval(tick, 1000);
  };

  const close = () => {
    stopProgress();
    dialog.close();
    dialog.remove();
  };

  const setStatus = (message: string) => {
    if (status) {
      status.textContent = message;
    }
  };

  const updateCount = () => {
    if (!countEl || !textArea) {
      return;
    }
    // Code points, because LinkedIn counts an emoji as one character.
    const length = Array.from(textArea.value).length;
    countEl.textContent = `${length} characters`;
    countEl.classList.toggle("lidraft__warn", length < 900 || length > 2200);
  };

  const show = (draft: LinkedInDraft) => {
    if (!output || !textArea) {
      return;
    }
    output.hidden = false;
    textArea.value = draft.text;
    updateCount();
    if (modelEl) {
      modelEl.textContent = draft.model;
    }
    if (issuesEl) {
      issuesEl.hidden = draft.issues.length === 0;
      issuesEl.innerHTML = draft.issues.length
        ? `<strong>Check before posting</strong><ul>${draft.issues
            .map((issue) => `<li>${escapeHtml(issue)}</li>`)
            .join("")}</ul>`
        : "";
    }
    if (mentionsEl) {
      mentionsEl.innerHTML = renderMentions(draft.authors);
    }
  };

  let lastPdfBase64 = "";

  const generate = async () => {
    if (!stored) {
      setStatus("Sign in first — drafting runs against your own session.");
      return;
    }
    const file = pdfInput?.files?.[0];
    if (!file && !lastPdfBase64) {
      setStatus("Choose the paper PDF first.");
      return;
    }
    if (file && file.size > MAX_PDF_BYTES) {
      setStatus("That PDF is over 20 MB — use the compiled paper rather than a scan.");
      return;
    }
    setStatus("");
    startProgress();
    try {
      if (file) {
        lastPdfBase64 = await readAsBase64(file);
      }
      const result = await draftLinkedInPost(
        {
          pdfBase64: lastPdfBase64,
          ...(paper.artifacts?.arxiv_url ? { url: paper.artifacts.arxiv_url } : {}),
          ...(venueInput?.value.trim() ? { venue: venueInput.value.trim() } : {}),
          ...(noteInput?.value.trim() ? { note: noteInput.value.trim() } : {}),
        },
        stored?.sessionToken ?? "",
        baseUrl,
      );
      if (!result.ok) {
        setStatus(
          result.message ??
            (result.kind === "unreachable"
              ? "AdminBot is not reachable."
              : "Could not generate the draft."),
        );
        return;
      }
      setStatus("");
      show(result.value);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      // In `finally` so a thrown error or a rejected request cannot leave the bar spinning
      // forever with the button stuck disabled.
      stopProgress();
    }
  };

  const copy = async (value: string, note: string) => {
    try {
      await navigator.clipboard.writeText(value);
      if (copiedEl) {
        copiedEl.textContent = note;
        setTimeout(() => {
          if (copiedEl) {
            copiedEl.textContent = "";
          }
        }, 2500);
      }
    } catch {
      if (copiedEl) {
        copiedEl.textContent = "Copy failed — select the text and copy by hand.";
      }
    }
  };

  textArea?.addEventListener("input", updateCount);

  dialog.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const act = target.closest("[data-act]")?.getAttribute("data-act");
    if (act === "close") {
      close();
    }
    if (act === "generate" || act === "regen") {
      void generate();
    }
    if (act === "copy" && textArea) {
      // The edited textarea, not the generated draft: whatever is on screen is what gets posted.
      void copy(textArea.value, "Copied — paste it into LinkedIn.");
    }
    const nameButton = target.closest<HTMLElement>(".lidraft__copy-name");
    if (nameButton) {
      const name = nameButton.dataset.name ?? "";
      void copy(name, `Copied “${name}” — type @ in LinkedIn, paste, pick the match.`);
    }
  });

  dialog.addEventListener("cancel", close);
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) {
      close();
    }
  });
}
