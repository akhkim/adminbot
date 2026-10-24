// The time-availability page's blank drafts, apart from the page itself: the app seeds its state
// with them at startup, and importing them from time-availability.ts would load the whole page
// before anyone opens it.
import { localTimezone } from "../data/timezones.ts";
import type { MilestoneDraft, TimeAvailabilityDraft } from "./time-availability.ts";

export const EMPTY_TIME_AVAILABILITY_DRAFT: TimeAvailabilityDraft = {
  category: "jinesis",
  customLabel: "",
  project: "",
  start: "",
  end: "",
  hoursPerWeek: "",
  wholeDay: true,
  note: "",
  link: "",
  editingIndex: null,
};

export const EMPTY_MILESTONE_DRAFT: MilestoneDraft = {
  date: "",
  label: "",
  link: "",
  time: "",
  // Prefilled with the browser's own zone rather than blank. Someone who types a time almost
  // always means their own clock, and a zone they have to go and find first is how a field ends up
  // answered wrong or left empty.
  timezone: localTimezone(),
};
