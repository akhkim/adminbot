// Local persistence for an in-progress logistics request.
//
// IndexedDB rather than localStorage because the draft carries files. localStorage holds strings
// only, so a PDF would have to be base64'd -- a third larger, encoded synchronously on the UI
// thread, into a store with a ~5MB cap that the whole origin shares. IndexedDB stores a File
// directly through structured clone and is async.
//
// A draft never leaves the browser: saving is a convenience so a half-filled request survives a
// reload, not a submission. Submitting is POST /logistics/requests -- see controllers/logistics.ts
// -- and a submitted request clears the draft it was built from, so the two can never both claim
// to be "the request".
import { localTimezone } from "./timezones.ts";

const DB_NAME = "adminbot-logistics";
const DB_VERSION = 1;
const STORE_NAME = "drafts";
// One draft per request type, never a shared record: the three forms hold different things and a
// member half-way through one must not lose it by opening another.
const SIGNATURE_DRAFT_KEY = "document-signature";
const LETTERS_DRAFT_KEY = "recommendation-letters";
const MEETING_DRAFT_KEY = "book-meeting";

/**
 * The suffix that makes a draft key one person's.
 *
 * Drafts live in IndexedDB, which is per-origin and not per-account: on a shared machine, or after
 * a logout and a different login, an unscoped key hands the next person the last one's half-written
 * request -- and their attached documents with it. Scoping the key is what keeps that from being
 * possible. A signed-out browser gets its own "anonymous" scope rather than sharing anybody's.
 */
export function logisticsDraftScope(memberId: string | null | undefined): string {
  return memberId?.trim() || "anonymous";
}

function scopedKey(key: string, scope: string): string {
  return `${key}:${scope}`;
}

export type LogisticsDraft = {
  description: string;
  signatureFiles: File[];
  attachments: File[];
  savedAt: number;
};

export type LogisticsDraftHost = {
  adminBotLogisticsDescription: string;
  adminBotLogisticsSignatureFiles: File[];
  adminBotLogisticsAttachments: File[];
  adminBotLogisticsSaving: boolean;
  adminBotLogisticsSavedAt: number | null;
  adminBotLogisticsSaveError: string | null;
};

/**
 * One row of the List of Schools table on a Recommendation Letters request.
 *
 * Every field is a string because every one of them is typed: the deadlines arrive from
 * `<input type="date">` as `yyyy-mm-dd`, and the two statuses are suggestions rather than a closed
 * set, so "waitlisted" or "letter uploaded" has somewhere to go.
 */
export type RecommendationSchool = {
  // View-side identity only, so lit keeps a row's inputs pointing at that row when one above it is
  // removed. Reassigned on restore rather than trusted from the record -- see the parser.
  id: string;
  school: string;
  applicationDeadline: string;
  applicationDeadlineTime: string;
  letterDeadline: string;
  letterDeadlineTime: string;
  /**
   * The zone both times on this row are read in, as an IANA name.
   *
   * One zone per row rather than one per deadline: a school states both its cutoffs on its own
   * clock, and two zone pickers on one row would be two chances to disagree about the same
   * campus. Blank means the dates are whole-day, which is how every row read before the times
   * existed -- and a time typed with no zone is exactly the ambiguity that makes a member submit
   * a day late from another country, so the form asks for it as soon as a time appears.
   */
  deadlineTimezone: string;
  applicationStatus: string;
  letterStatus: string;
  program: string;
  programLink: string;
  notes: string;
};

/**
 * One line of "what this person actually did", for the letter writer.
 *
 * The letter itself is a Drive template and stays one: prose, formatting and the writer's own
 * voice do not belong in a form. What a template cannot supply is the part only the member knows --
 * which project, and what they contributed to it. Writers were reconstructing that from memory and
 * from Slack, which is how a year of work becomes one sentence.
 *
 * Deliberately two columns and not a free-text box: a paragraph gets skimmed, and a row per project
 * is what makes an omission visible.
 */
export type LetterFact = {
  // View-side identity only, like RecommendationSchool.id -- reassigned on restore.
  id: string;
  project: string;
  contribution: string;
};

export type RecommendationLettersDraft = {
  schools: RecommendationSchool[];
  facts: LetterFact[];
  // The two links the request travels with: the CV the letter is written against, and the member's
  // own copy of the filled-in templates.
  cvOverleafUrl: string;
  driveFolderUrl: string;
  savedAt: number;
};

export type RecommendationLettersDraftHost = {
  adminBotLettersSchools: RecommendationSchool[];
  adminBotLettersFacts: LetterFact[];
  adminBotLettersCvOverleafUrl: string;
  adminBotLettersDriveFolderUrl: string;
  adminBotLettersSaving: boolean;
  adminBotLettersSavedAt: number | null;
  adminBotLettersSaveError: string | null;
};

/**
 * One row of the Book Meeting request table.
 *
 * A meeting request is four facts and a timestamp, which is a spreadsheet and not a form: the
 * people who schedule these are reading many at once, and a form per request made them open each
 * one to find out whether it was a fifteen-minute check-in or an hour-long committee call.
 *
 * `submittedAt` is stamped when the row is created rather than typed, because "when they asked" is
 * the column that decides who gets scheduled first and it is the one nobody would fill in honestly.
 */
export type MeetingRequestRow = {
  id: string;
  submittedAt: number;
  purpose: string;
  preferredTime: string;
  // IANA zone the preferred time is read in. Prefilled from the browser, since a member proposing
  // a time means their own clock -- and a proposed time with no zone is a meeting booked in the
  // wrong half of the day.
  timezone: string;
  // Minutes, as a string: it is typed, and the same "everything is a string" rule the schools
  // table follows keeps the parser one-path.
  lengthMinutes: string;
};

export type MeetingRequestDraft = { meetings: MeetingRequestRow[]; savedAt: number };

export type MeetingRequestDraftHost = {
  adminBotMeetingRows: MeetingRequestRow[];
  adminBotMeetingSaving: boolean;
  adminBotMeetingSavedAt: number | null;
  adminBotMeetingSaveError: string | null;
};

const EMPTY_SCHOOL: Omit<RecommendationSchool, "id"> = {
  school: "",
  applicationDeadline: "",
  applicationDeadlineTime: "",
  letterDeadline: "",
  letterDeadlineTime: "",
  deadlineTimezone: "",
  applicationStatus: "",
  letterStatus: "",
  program: "",
  programLink: "",
  notes: "",
};

const SCHOOL_FIELD_KEYS = Object.keys(EMPTY_SCHOOL) as (keyof typeof EMPTY_SCHOOL)[];

// Ids only have to be unique among the rows on screen, so a counter is enough and -- unlike a UUID
// -- needs no crypto to exist, which keeps the table working in a test environment.
let schoolRowCount = 0;

export function createSchoolRow(fields: Partial<RecommendationSchool> = {}): RecommendationSchool {
  schoolRowCount += 1;
  // Id assigned last so copying an existing row's fields cannot copy its identity too.
  return { ...EMPTY_SCHOOL, ...fields, id: `school-${schoolRowCount}` };
}

export function isEmptySchoolRow(row: RecommendationSchool): boolean {
  return SCHOOL_FIELD_KEYS.every((key) => !row[key].trim());
}

function parseSchoolRow(value: unknown): RecommendationSchool | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const fields: Partial<RecommendationSchool> = {};
  for (const key of SCHOOL_FIELD_KEYS) {
    const stored = record[key];
    if (typeof stored === "string") {
      fields[key] = stored;
    }
  }
  return createSchoolRow(fields);
}

/**
 * Reads a stored Recommendation Letters draft, or null when there is nothing worth putting back.
 *
 * Same contract as the signature parser: a record written by an older build has to degrade to "no
 * draft" rather than throw into the restore path. Rows survive individually, so one unreadable
 * entry costs that row and not the table.
 */
export function parseRecommendationLettersDraft(value: unknown): RecommendationLettersDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const schools = Array.isArray(record.schools)
    ? record.schools.map(parseSchoolRow).filter((row): row is RecommendationSchool => row !== null)
    : [];
  const facts = Array.isArray(record.facts)
    ? record.facts.map(parseFactRow).filter((row): row is LetterFact => row !== null)
    : [];
  const cvOverleafUrl = typeof record.cvOverleafUrl === "string" ? record.cvOverleafUrl : "";
  const driveFolderUrl = typeof record.driveFolderUrl === "string" ? record.driveFolderUrl : "";
  const savedAt = typeof record.savedAt === "number" && record.savedAt > 0 ? record.savedAt : 0;
  // A blank table and two blank links is the same as no draft, and restoring it would put a
  // "Saved" time on a form nobody filled in. `every` on an empty list covers the no-rows case too.
  if (
    schools.every(isEmptySchoolRow) &&
    facts.every(isEmptyFactRow) &&
    !cvOverleafUrl.trim() &&
    !driveFolderUrl.trim()
  ) {
    return null;
  }
  return { schools, facts, cvOverleafUrl, driveFolderUrl, savedAt };
}

const EMPTY_FACT: Omit<LetterFact, "id"> = { project: "", contribution: "" };

let factRowCount = 0;

export function createFactRow(fields: Partial<LetterFact> = {}): LetterFact {
  factRowCount += 1;
  return { ...EMPTY_FACT, ...fields, id: `fact-${factRowCount}` };
}

export function isEmptyFactRow(row: LetterFact): boolean {
  return !row.project.trim() && !row.contribution.trim();
}

function parseFactRow(value: unknown): LetterFact | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return createFactRow({
    ...(typeof record.project === "string" ? { project: record.project } : {}),
    ...(typeof record.contribution === "string" ? { contribution: record.contribution } : {}),
  });
}

let meetingRowCount = 0;

export function createMeetingRow(fields: Partial<MeetingRequestRow> = {}): MeetingRequestRow {
  meetingRowCount += 1;
  return {
    purpose: "",
    preferredTime: "",
    timezone: localTimezone(),
    lengthMinutes: "",
    // Stamped here, not on save: the column answers "when did they ask", and a save-time stamp
    // would move every row forward each time the member touched any other one.
    submittedAt: Date.now(),
    ...fields,
    id: `meeting-${meetingRowCount}`,
  };
}

export function isEmptyMeetingRow(row: MeetingRequestRow): boolean {
  return !row.purpose.trim() && !row.preferredTime.trim() && !row.lengthMinutes.trim();
}

function parseMeetingRow(value: unknown): MeetingRequestRow | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const stored = record[key];
    return typeof stored === "string" ? stored : undefined;
  };
  const purpose = text("purpose");
  const preferredTime = text("preferredTime");
  const timezone = text("timezone");
  const lengthMinutes = text("lengthMinutes");
  return createMeetingRow({
    ...(purpose === undefined ? {} : { purpose }),
    ...(preferredTime === undefined ? {} : { preferredTime }),
    // `undefined` means the record never had the field; an empty string means the member cleared
    // it on purpose, and putting the browser's zone back would silently answer for them.
    ...(timezone === undefined ? {} : { timezone }),
    ...(lengthMinutes === undefined ? {} : { lengthMinutes }),
    // A stored stamp is kept as it is; only a row that never had one gets today's clock, which is
    // the least wrong answer available for a record written before the column existed.
    ...(typeof record.submittedAt === "number" && record.submittedAt > 0
      ? { submittedAt: record.submittedAt }
      : {}),
  });
}

/** Same "an empty draft is no draft" contract as the other two parsers. */
export function parseMeetingRequestDraft(value: unknown): MeetingRequestDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const meetings = Array.isArray(record.meetings)
    ? record.meetings.map(parseMeetingRow).filter((row): row is MeetingRequestRow => row !== null)
    : [];
  const savedAt = typeof record.savedAt === "number" && record.savedAt > 0 ? record.savedAt : 0;
  if (meetings.every(isEmptyMeetingRow)) {
    return null;
  }
  return { meetings, savedAt };
}

function isFile(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

function fileList(value: unknown): File[] {
  return Array.isArray(value) ? value.filter(isFile) : [];
}

/**
 * Reads whatever IndexedDB handed back into a draft, or null when the record is unusable.
 *
 * Anything stored by an older build of this form is read on the next visit, so a record that no
 * longer matches has to degrade to "no draft" rather than throw into the restore path and leave
 * the tab blank. Each field falls back independently: a corrupt file list still lets the typed
 * description come back.
 */
export function parseLogisticsDraft(value: unknown): LogisticsDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description : "";
  const signatureFiles = fileList(record.signatureFiles);
  const attachments = fileList(record.attachments);
  const savedAt = typeof record.savedAt === "number" && record.savedAt > 0 ? record.savedAt : 0;
  // An empty draft is indistinguishable from no draft, and restoring it would show a "Saved"
  // timestamp for a form the member never filled in.
  if (!description && !signatureFiles.length && !attachments.length) {
    return null;
  }
  return { description, signatureFiles, attachments, savedAt };
}

function openDatabase(): Promise<IDBDatabase> {
  const factory: IDBFactory | undefined = globalThis.indexedDB;
  if (factory === undefined) {
    // Private-mode browsers and non-DOM test environments have no IndexedDB. Saving reports this
    // rather than pretending the draft was written.
    return Promise.reject(new Error("This browser has no local storage available."));
  }
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Could not open local storage.")),
    );
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("Local storage write failed.")),
      );
      transaction.addEventListener("abort", () =>
        reject(transaction.error ?? new Error("Local storage write failed.")),
      );
    });
  } finally {
    // Closing is deferred until the transaction settles; an open handle blocks a later version
    // upgrade in another tab.
    db.close();
  }
}

export async function saveLogisticsDraft(draft: LogisticsDraft, scope: string): Promise<void> {
  await withStore("readwrite", (store) => store.put(draft, scopedKey(SIGNATURE_DRAFT_KEY, scope)));
}

export async function loadLogisticsDraft(scope: string): Promise<LogisticsDraft | null> {
  const stored = await withStore("readonly", (store) =>
    store.get(scopedKey(SIGNATURE_DRAFT_KEY, scope)),
  );
  return parseLogisticsDraft(stored);
}

export async function clearLogisticsDraft(scope: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(scopedKey(SIGNATURE_DRAFT_KEY, scope)));
}

export async function saveRecommendationLettersDraft(
  draft: RecommendationLettersDraft,
  scope: string,
): Promise<void> {
  await withStore("readwrite", (store) => store.put(draft, scopedKey(LETTERS_DRAFT_KEY, scope)));
}

export async function loadRecommendationLettersDraft(
  scope: string,
): Promise<RecommendationLettersDraft | null> {
  const stored = await withStore("readonly", (store) =>
    store.get(scopedKey(LETTERS_DRAFT_KEY, scope)),
  );
  return parseRecommendationLettersDraft(stored);
}

export async function clearRecommendationLettersDraft(scope: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(scopedKey(LETTERS_DRAFT_KEY, scope)));
}

export async function saveMeetingRequestDraft(
  draft: MeetingRequestDraft,
  scope: string,
): Promise<void> {
  await withStore("readwrite", (store) => store.put(draft, scopedKey(MEETING_DRAFT_KEY, scope)));
}

export async function loadMeetingRequestDraft(scope: string): Promise<MeetingRequestDraft | null> {
  const stored = await withStore("readonly", (store) =>
    store.get(scopedKey(MEETING_DRAFT_KEY, scope)),
  );
  return parseMeetingRequestDraft(stored);
}

export async function clearMeetingRequestDraft(scope: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(scopedKey(MEETING_DRAFT_KEY, scope)));
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Could not save on this device.";
}

/** Writes what is on screen now. Host state carries the outcome so the view can report it. */
export async function saveAdminBotLogisticsDraft(
  host: LogisticsDraftHost,
  scope: string,
): Promise<void> {
  host.adminBotLogisticsSaving = true;
  host.adminBotLogisticsSaveError = null;
  const savedAt = Date.now();
  try {
    await saveLogisticsDraft(
      {
        description: host.adminBotLogisticsDescription,
        signatureFiles: host.adminBotLogisticsSignatureFiles,
        attachments: host.adminBotLogisticsAttachments,
        savedAt,
      },
      scope,
    );
    host.adminBotLogisticsSavedAt = savedAt;
  } catch (error) {
    host.adminBotLogisticsSaveError = describeError(error);
  } finally {
    host.adminBotLogisticsSaving = false;
  }
}

/**
 * Puts a previously saved draft back on screen. Silent on failure: a member who never saved
 * anything, or whose browser blocks IndexedDB, should get an empty form rather than an error for
 * something they did not ask for.
 */
export async function restoreAdminBotLogisticsDraft(
  host: LogisticsDraftHost,
  scope: string,
): Promise<void> {
  const draft = await loadLogisticsDraft(scope).catch(() => null);
  if (!draft) {
    return;
  }
  host.adminBotLogisticsDescription = draft.description;
  host.adminBotLogisticsSignatureFiles = draft.signatureFiles;
  host.adminBotLogisticsAttachments = draft.attachments;
  host.adminBotLogisticsSavedAt = draft.savedAt || null;
}

/**
 * The same write, save state and failure reporting as the signature draft, against the letters
 * record. Kept as its own pair rather than one parameterised saver: each request type owns its
 * "Saved at" so switching templates never reports the other form's outcome.
 */
export async function saveAdminBotLettersDraft(
  host: RecommendationLettersDraftHost,
  scope: string,
): Promise<void> {
  host.adminBotLettersSaving = true;
  host.adminBotLettersSaveError = null;
  const savedAt = Date.now();
  try {
    await saveRecommendationLettersDraft(
      {
        schools: host.adminBotLettersSchools,
        facts: host.adminBotLettersFacts,
        cvOverleafUrl: host.adminBotLettersCvOverleafUrl,
        driveFolderUrl: host.adminBotLettersDriveFolderUrl,
        savedAt,
      },
      scope,
    );
    host.adminBotLettersSavedAt = savedAt;
  } catch (error) {
    host.adminBotLettersSaveError = describeError(error);
  } finally {
    host.adminBotLettersSaving = false;
  }
}

/** Silent on failure, for the same reason the signature restore is. */
export async function restoreAdminBotLettersDraft(
  host: RecommendationLettersDraftHost,
  scope: string,
): Promise<void> {
  const draft = await loadRecommendationLettersDraft(scope).catch(() => null);
  if (!draft) {
    return;
  }
  host.adminBotLettersSchools = draft.schools;
  // An older record has no facts list. Leaving the host's default single blank row in place beats
  // replacing it with an empty array, which would render a table with no row to type in.
  if (draft.facts.length) {
    host.adminBotLettersFacts = draft.facts;
  }
  host.adminBotLettersCvOverleafUrl = draft.cvOverleafUrl;
  host.adminBotLettersDriveFolderUrl = draft.driveFolderUrl;
  host.adminBotLettersSavedAt = draft.savedAt || null;
}

/** The meeting table's own save and restore, on the same contract as the other two. */
export async function saveAdminBotMeetingDraft(
  host: MeetingRequestDraftHost,
  scope: string,
): Promise<void> {
  host.adminBotMeetingSaving = true;
  host.adminBotMeetingSaveError = null;
  const savedAt = Date.now();
  try {
    await saveMeetingRequestDraft({ meetings: host.adminBotMeetingRows, savedAt }, scope);
    host.adminBotMeetingSavedAt = savedAt;
  } catch (error) {
    host.adminBotMeetingSaveError = describeError(error);
  } finally {
    host.adminBotMeetingSaving = false;
  }
}

/** Silent on failure, for the same reason the other restores are. */
export async function restoreAdminBotMeetingDraft(
  host: MeetingRequestDraftHost,
  scope: string,
): Promise<void> {
  const draft = await loadMeetingRequestDraft(scope).catch(() => null);
  if (!draft) {
    return;
  }
  host.adminBotMeetingRows = draft.meetings;
  host.adminBotMeetingSavedAt = draft.savedAt || null;
}
