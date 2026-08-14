// What a Recommendation Letters request is made of, named once.
//
// The form types these columns in and the admin detail reads them back, so the two would drift the
// moment each kept its own list of headings. Both import this one.
import type { RecommendationSchool } from "../data/logistics-draft.ts";

export type SchoolFieldKey = Exclude<keyof RecommendationSchool, "id">;

export type SchoolField = {
  key: SchoolFieldKey;
  labelKey: string;
  // Second line under the column name, for a heading that needs a qualifier to be understood.
  hintKey?: string;
  control: "text" | "date" | "url" | "suggest" | "notes";
  placeholderKey?: string;
  // Only for "suggest": the datalist this column's input reads its offered words from.
  listId?: string;
};

// Both statuses are offered rather than enforced. The words below are the ones a request usually
// passes through, but an application that is waitlisted or a letter the writer has half-drafted
// still has to be sayable, so these are a datalist on a text input and not a <select>.
export const APPLICATION_STATUS_LIST_ID = "logistics-application-status";
export const LETTER_STATUS_LIST_ID = "logistics-letter-status";
export const APPLICATION_STATUS_SUGGESTIONS = ["submitted", "accepted", "declined"];
export const LETTER_STATUS_SUGGESTIONS = ["requested", "submitted"];

// The folder the lab keeps its letter templates in. A URL, not a translated string: a locale bundle
// is no place for a link that has to stay byte-identical to be the right folder.
export const TEMPLATE_FOLDER_URL =
  "https://drive.google.com/drive/folders/1Ld_fhN--dk1P2bM9P_3W-TsYgsQG0Wj2";

// In the order a member works across a row: which school, when each deadline falls, where both
// halves of the request stand, then what the program is.
export const SCHOOL_FIELDS: SchoolField[] = [
  {
    key: "school",
    labelKey: "logistics.schools.school",
    control: "text",
    placeholderKey: "logistics.schools.schoolPlaceholder",
  },
  {
    key: "applicationDeadline",
    labelKey: "logistics.schools.applicationDeadline",
    control: "date",
  },
  {
    key: "letterDeadline",
    labelKey: "logistics.schools.letterDeadline",
    hintKey: "logistics.schools.letterDeadlineHint",
    control: "date",
  },
  {
    key: "applicationStatus",
    labelKey: "logistics.schools.applicationStatus",
    control: "suggest",
    listId: APPLICATION_STATUS_LIST_ID,
    placeholderKey: "logistics.schools.applicationStatusPlaceholder",
  },
  {
    key: "letterStatus",
    labelKey: "logistics.schools.letterStatus",
    control: "suggest",
    listId: LETTER_STATUS_LIST_ID,
    placeholderKey: "logistics.schools.letterStatusPlaceholder",
  },
  {
    key: "program",
    labelKey: "logistics.schools.program",
    control: "text",
    placeholderKey: "logistics.schools.programPlaceholder",
  },
  {
    key: "programLink",
    labelKey: "logistics.schools.programLink",
    control: "url",
    placeholderKey: "logistics.schools.programLinkPlaceholder",
  },
  {
    key: "notes",
    labelKey: "logistics.schools.notes",
    hintKey: "logistics.schools.notesHint",
    control: "notes",
    placeholderKey: "logistics.schools.notesPlaceholder",
  },
];
