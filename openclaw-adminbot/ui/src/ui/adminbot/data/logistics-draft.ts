// Local persistence for an in-progress logistics request.
//
// IndexedDB rather than localStorage because the draft carries files. localStorage holds strings
// only, so a PDF would have to be base64'd -- a third larger, encoded synchronously on the UI
// thread, into a store with a ~5MB cap that the whole origin shares. IndexedDB stores a File
// directly through structured clone and is async.
//
// This is the member's own device and nothing else: the draft never leaves the browser. Saving is
// a convenience so a half-filled request survives a reload, not a submission -- that path does not
// exist yet and will go through propose -> approve -> execute when it does.
const DB_NAME = "adminbot-logistics";
const DB_VERSION = 1;
const STORE_NAME = "drafts";
// One draft per request type, never a shared record: the two forms hold different things and a
// member half-way through one must not lose it by opening the other. Book Meeting gets its own
// key when it grows a form.
const SIGNATURE_DRAFT_KEY = "document-signature";
const LETTERS_DRAFT_KEY = "recommendation-letters";

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
  letterDeadline: string;
  applicationStatus: string;
  letterStatus: string;
  program: string;
  programLink: string;
  notes: string;
};

export type RecommendationLettersDraft = {
  schools: RecommendationSchool[];
  // The two links the request travels with: the CV the letter is written against, and the member's
  // own copy of the filled-in templates.
  cvOverleafUrl: string;
  driveFolderUrl: string;
  savedAt: number;
};

export type RecommendationLettersDraftHost = {
  adminBotLettersSchools: RecommendationSchool[];
  adminBotLettersCvOverleafUrl: string;
  adminBotLettersDriveFolderUrl: string;
  adminBotLettersSaving: boolean;
  adminBotLettersSavedAt: number | null;
  adminBotLettersSaveError: string | null;
};

const EMPTY_SCHOOL: Omit<RecommendationSchool, "id"> = {
  school: "",
  applicationDeadline: "",
  letterDeadline: "",
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
  const cvOverleafUrl = typeof record.cvOverleafUrl === "string" ? record.cvOverleafUrl : "";
  const driveFolderUrl = typeof record.driveFolderUrl === "string" ? record.driveFolderUrl : "";
  const savedAt = typeof record.savedAt === "number" && record.savedAt > 0 ? record.savedAt : 0;
  // A blank table and two blank links is the same as no draft, and restoring it would put a
  // "Saved" time on a form nobody filled in. `every` on an empty list covers the no-rows case too.
  if (schools.every(isEmptySchoolRow) && !cvOverleafUrl.trim() && !driveFolderUrl.trim()) {
    return null;
  }
  return { schools, cvOverleafUrl, driveFolderUrl, savedAt };
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

export async function saveLogisticsDraft(draft: LogisticsDraft): Promise<void> {
  await withStore("readwrite", (store) => store.put(draft, SIGNATURE_DRAFT_KEY));
}

export async function loadLogisticsDraft(): Promise<LogisticsDraft | null> {
  const stored = await withStore("readonly", (store) => store.get(SIGNATURE_DRAFT_KEY));
  return parseLogisticsDraft(stored);
}

export async function clearLogisticsDraft(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(SIGNATURE_DRAFT_KEY));
}

export async function saveRecommendationLettersDraft(
  draft: RecommendationLettersDraft,
): Promise<void> {
  await withStore("readwrite", (store) => store.put(draft, LETTERS_DRAFT_KEY));
}

export async function loadRecommendationLettersDraft(): Promise<RecommendationLettersDraft | null> {
  const stored = await withStore("readonly", (store) => store.get(LETTERS_DRAFT_KEY));
  return parseRecommendationLettersDraft(stored);
}

export async function clearRecommendationLettersDraft(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(LETTERS_DRAFT_KEY));
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Could not save on this device.";
}

/** Writes what is on screen now. Host state carries the outcome so the view can report it. */
export async function saveAdminBotLogisticsDraft(host: LogisticsDraftHost): Promise<void> {
  host.adminBotLogisticsSaving = true;
  host.adminBotLogisticsSaveError = null;
  const savedAt = Date.now();
  try {
    await saveLogisticsDraft({
      description: host.adminBotLogisticsDescription,
      signatureFiles: host.adminBotLogisticsSignatureFiles,
      attachments: host.adminBotLogisticsAttachments,
      savedAt,
    });
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
export async function restoreAdminBotLogisticsDraft(host: LogisticsDraftHost): Promise<void> {
  const draft = await loadLogisticsDraft().catch(() => null);
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
): Promise<void> {
  host.adminBotLettersSaving = true;
  host.adminBotLettersSaveError = null;
  const savedAt = Date.now();
  try {
    await saveRecommendationLettersDraft({
      schools: host.adminBotLettersSchools,
      cvOverleafUrl: host.adminBotLettersCvOverleafUrl,
      driveFolderUrl: host.adminBotLettersDriveFolderUrl,
      savedAt,
    });
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
): Promise<void> {
  const draft = await loadRecommendationLettersDraft().catch(() => null);
  if (!draft) {
    return;
  }
  host.adminBotLettersSchools = draft.schools;
  host.adminBotLettersCvOverleafUrl = draft.cvOverleafUrl;
  host.adminBotLettersDriveFolderUrl = draft.driveFolderUrl;
  host.adminBotLettersSavedAt = draft.savedAt || null;
}
