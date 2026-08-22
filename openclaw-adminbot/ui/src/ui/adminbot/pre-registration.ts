// The pre-registration banner and its dialog.
//
// Nothing here collects information the lab already holds. A registered paper already carries its
// title, its author list and its Overleaf link; the one thing missing before a deadline is which
// venue it is aimed at and how likely that is. So the dialog is three taps -- pick the paper,
// tick the venues, pick the odds -- and never a form.
//
// Built imperatively for the same reason paperflow-map.ts and the draft dialog are: it owns a
// <dialog> and some selection state that dies with it.

import type { AdminBotPaperRecord, AdminBotPaperSaveInput } from "./controllers/admin.ts";
import type { AdminBotPaperStep } from "../../../../extensions/adminbot/src/contracts/actions.js";
import {
  CONFIDENCE_CHOICES,
  PRE_REGISTRATION_VENUES,
  daysUntil,
  formatVenueTargets,
  readVenueTargets,
  serializeVenueTargets,
  type VenueTarget,
} from "./venue-targets.ts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export type PreRegistrationDeps = {
  papers: AdminBotPaperRecord[];
  onSavePaper: (input: AdminBotPaperSaveInput) => void;
  onDone: () => void;
};


/** Whether this paper would appear complete in the admin's venue table. */
function overleafOf(paper: AdminBotPaperRecord | undefined): string {
  return (
    paper?.artifacts?.overleaf_edit_url?.trim() ||
    paper?.artifacts?.overleaf_view_url?.trim() ||
    ""
  );
}

export function openPreRegistrationDialog(deps: PreRegistrationDeps): void {
  const dialog = document.createElement("dialog");
  dialog.className = "prereg";

  // Chosen per paper, so someone can register two papers in one sitting without reopening.
  let paperId = deps.papers[0]?.id ?? "";
  const picked = new Map<string, number>();
  // Typed here rather than on the card, because the spreadsheet the admins read has an Overleaf
  // column and a pre-registration without one is a row they cannot use. Asking at the moment the
  // gap is visible beats sending someone away to find the field.
  let overleafDraft = "";

  const currentPaper = () => deps.papers.find((paper) => paper.id === paperId);

  const seedFromPaper = () => {
    picked.clear();
    overleafDraft = "";
    for (const target of readVenueTargets(currentPaper() as AdminBotPaperRecord)) {
      picked.set(target.venue_id, target.confidence);
    }
  };
  if (paperId) {
    seedFromPaper();
  }

  /**
   * What is still missing before this paper reads properly in the admin table.
   *
   * Only the Overleaf link, deliberately. Title and authors come with registration, and asking
   * for anything else here would turn a three-tap flow back into the form it exists to avoid.
   */
  const missingSection = (paper: AdminBotPaperRecord | undefined) => {
    if (!paper || overleafOf(paper)) {
      return "";
    }
    return `
      <section class="prereg__missing">
        <h4 class="prereg__step">3 · One thing missing</h4>
        <p class="prereg__missing-note">
          This paper has no Overleaf link, so it will show as a blank cell where the lab looks for
          it. Add it here and it is saved with the registration.
        </p>
        <input class="prereg__overleaf" type="url" data-el="overleaf"
          placeholder="https://overleaf.com/project/65f2a1c9d4e3b7a801f6"
          value="${escapeHtml(overleafDraft)}" />
      </section>`;
  };

  const render = () => {
    const paper = currentPaper();
    dialog.innerHTML = `
      <div class="prereg__bar">
        <div>
          <strong>Conference pre-registration</strong>
          <span class="prereg__sub">Nothing is retyped — pick the paper, then where it is going.</span>
        </div>
        <button type="button" class="btn btn--sm" data-act="close">Close</button>
      </div>

      <div class="prereg__body">
        <section>
          <h4 class="prereg__step">1 · Which paper?</h4>
          <div class="prereg__papers">
            ${deps.papers
              .map((entry) => {
                const targets = readVenueTargets(entry);
                const already = targets.length
                  ? `<span class="prereg__already">${escapeHtml(formatVenueTargets(targets))}</span>`
                  : "";
                return `<button type="button" class="prereg__paper ${
                  entry.id === paperId ? "is-selected" : ""
                }" data-paper="${escapeHtml(entry.id)}">
                  <span class="prereg__paper-title">${escapeHtml(entry.title)}</span>${already}
                </button>`;
              })
              .join("")}
          </div>
          <!-- The paper has to exist before it can be pointed at a venue. Someone whose paper is
               not on this list has not registered it at all, and the fix is one button away on
               the page behind this dialog -- so say that rather than offering a second, partial
               way to create one here. -->
          <p class="prereg__nothere">
            Not listed? Close this and press <strong>Add a project</strong> first — a paper has to
            be registered before it can be pre-registered.
          </p>
        </section>

        <section>
          <h4 class="prereg__step">2 · Where is it going? <em>(more than one is fine)</em></h4>
          <div class="prereg__venues">
            ${PRE_REGISTRATION_VENUES.map((venue) => {
              const on = picked.has(venue.venue_id);
              const days = daysUntil(venue.deadline);
              const due =
                days === undefined
                  ? ""
                  : `<span class="prereg__due">${days} day${days === 1 ? "" : "s"} left</span>`;
              return `
                <div class="prereg__venue ${on ? "is-on" : ""}">
                  <button type="button" class="prereg__venue-toggle" data-venue="${venue.venue_id}">
                    <span>${escapeHtml(venue.label)}</span>${due}
                  </button>
                  <div class="prereg__odds" ${on ? "" : "hidden"}>
                    ${CONFIDENCE_CHOICES.map(
                      (value) => `<button type="button"
                        class="prereg__odd ${picked.get(venue.venue_id) === value ? "is-on" : ""}"
                        data-venue="${venue.venue_id}" data-odds="${value}">${value}%</button>`,
                    ).join("")}
                  </div>
                </div>`;
            }).join("")}
          </div>
        </section>
      </div>

      ${missingSection(paper)}
      <div class="prereg__foot">
        <button type="button" class="btn primary" data-act="save" ${
          paper && picked.size > 0 ? "" : "disabled"
        }>
          ${
            picked.size > 0
              ? `Pre-register for ${[...picked.keys()].length} venue${picked.size === 1 ? "" : "s"}`
              : "Pick a venue"
          }
        </button>
        <span class="prereg__foot-note">${
          paper ? escapeHtml(paper.title) : "No papers to register"
        }</span>
      </div>
    `;
  };

  const close = () => {
    dialog.close();
    dialog.remove();
    deps.onDone();
  };

  const save = () => {
    const paper = currentPaper();
    if (!paper) {
      return;
    }
    const targets: VenueTarget[] = [...picked.entries()].map(([venue_id, confidence]) => ({
      venue_id,
      label: PRE_REGISTRATION_VENUES.find((v) => v.venue_id === venue_id)?.label ?? venue_id,
      confidence,
    }));
    const overleaf = overleafDraft.trim();
    deps.onSavePaper({
      id: paper.id,
      title: paper.title,
      authors: paper.authors ?? [],
      currentStep: paper.current_step as AdminBotPaperStep,
      venueTargets: serializeVenueTargets(targets),
      // Only when the author actually typed one: an empty string here would clear a link that
      // was already on file under the other Overleaf field.
      ...(overleaf ? { overleafEditUrl: overleaf } : {}),
    });
    close();
  };

  dialog.addEventListener("input", (event) => {
    const field = event.target as HTMLInputElement;
    if (field.dataset.el === "overleaf") {
      overleafDraft = field.value;
    }
  });

  dialog.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const act = target.closest("[data-act]")?.getAttribute("data-act");
    if (act === "close") {
      close();
      return;
    }
    if (act === "save") {
      save();
      return;
    }
    const paperButton = target.closest<HTMLElement>("[data-paper]");
    if (paperButton) {
      paperId = paperButton.dataset.paper ?? "";
      seedFromPaper();
      render();
      return;
    }
    const odds = target.closest<HTMLElement>("[data-odds]");
    if (odds) {
      picked.set(odds.dataset.venue ?? "", Number(odds.dataset.odds));
      render();
      return;
    }
    const venueToggle = target.closest<HTMLElement>("[data-venue]");
    if (venueToggle) {
      const id = venueToggle.dataset.venue ?? "";
      if (picked.has(id)) {
        picked.delete(id);
      } else {
        // 80 rather than the lowest: someone ticking a venue three weeks out has usually decided,
        // and an odds picker that starts at "probably not" reads as an argument.
        picked.set(id, 80);
      }
      render();
    }
  });

  dialog.addEventListener("cancel", close);
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) {
      close();
    }
  });

  render();
  document.body.appendChild(dialog);
  dialog.showModal();
}
