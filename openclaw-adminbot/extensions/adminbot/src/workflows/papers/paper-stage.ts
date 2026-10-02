// Where a paper actually is, read off its evidence rather than off a field somebody maintains.
//
// The slot registry has always carried `gates` -- "the pipeline step this slot releases" -- and
// nothing has ever read it. This is the reader. A step is released when every required slot that
// gates it is settled, and the paper's stage is the furthest released step: the same arrangement
// the venue half of PaperFlow already uses, where `openPaperflowStage` derives the open stage from
// evidence and stores no position at all.
//
// Two properties the walk has to have, and both are about not lying:
//
//   - Contiguous. The walk stops at the first step whose evidence is incomplete, so a poster
//     uploaded in week one cannot report a paper as being at `poster_making` while it is still
//     being written. The branches run in parallel off the compiled PDF; the trunk is what a stage
//     means.
//   - Forward only. Deriving is not the same as overwriting: the service advances a paper to the
//     derived step and never past a step somebody set by hand. Evidence can arrive late, be
//     corrected, or be waived, and a stage that walked backwards on its own would be a record
//     nobody could trust.
//
// Pure: papers and slots in, a decision out. The service writes.
import { adminBotPaperSteps, type AdminBotPaperStep } from "../../contracts/actions.js";
import {
  adminBotPaperSlotRegistry,
  adminBotPaperSlots,
  isAdminBotPaperSlotSettled,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";

/**
 * The required slots that release each step, from the registry's own `gates`.
 *
 * Computed rather than written out, so a slot added to the registry with a `gates` value is part
 * of the stage model the moment it exists -- and a second list here would be a second answer to
 * "what does this step need", free to disagree with the one the nudge sweep reads.
 *
 * Advisory slots are deliberately out: `overleaf_view` gates `submission` too, and a paper whose
 * authors only ever circulated the edit link is not stuck before submission because of it.
 */
export const adminBotStepGatingSlots: Record<AdminBotPaperStep, readonly AdminBotPaperSlot[]> =
  Object.fromEntries(
    adminBotPaperSteps.map((step) => [
      step,
      adminBotPaperSlots.filter((slot) => {
        const definition = adminBotPaperSlotRegistry[slot];
        return definition.required && definition.gates === step;
      }),
    ]),
    // `Object.fromEntries` widens the key back to `string`, and the entries above are built from
    // the step list itself, so every key is present by construction.
  ) as unknown as Record<AdminBotPaperStep, readonly AdminBotPaperSlot[]>;

export type PaperStageReading = {
  /** The furthest step the evidence releases. The first step when nothing is released yet. */
  step: AdminBotPaperStep;
  /** The step the paper is working towards, or absent when the trunk is finished. */
  next?: AdminBotPaperStep;
  /** What `next` is still waiting on. Empty only when there is no next step. */
  blocking: readonly AdminBotPaperSlot[];
  /** The slots that released `step`, which is the evidence an advance is recorded against. */
  evidence: readonly AdminBotPaperSlot[];
};

/** Where the evidence says this paper is. */
export function derivePaperStage(slots: readonly AdminBotPaperSlotRecord[]): PaperStageReading {
  const settled = (slot: AdminBotPaperSlot) =>
    isAdminBotPaperSlotSettled(slots.find((row) => row.slot === slot)?.status ?? "missing");

  let step: AdminBotPaperStep = adminBotPaperSteps[0];
  let evidence: readonly AdminBotPaperSlot[] = [];
  for (const candidate of adminBotPaperSteps) {
    const gating = adminBotStepGatingSlots[candidate];
    // Nothing evidences this one -- `brainstorming_docs` is the paper existing, `slide_making` is
    // branch work with no gate of its own. Neither moves a paper and neither stops the walk.
    if (gating.length === 0) {
      continue;
    }
    if (!gating.every(settled)) {
      return { step, next: candidate, blocking: gating.filter((slot) => !settled(slot)), evidence };
    }
    step = candidate;
    evidence = gating;
  }
  return { step, blocking: [], evidence };
}

/**
 * Whether the derived stage is ahead of the stored one, and by how far.
 *
 * Index comparison against the canonical order, so a `current_step` this deployment has never
 * heard of -- an import, a hand edit, a step renamed in a later version -- reads as "before
 * everything" and is advanced rather than treated as further along than it is.
 */
export function isStageAhead(stored: string | undefined, derived: AdminBotPaperStep): boolean {
  const order = (step: string | undefined): number =>
    adminBotPaperSteps.indexOf(step as AdminBotPaperStep);
  return order(derived) > order(stored);
}
