import type {
  GenerateReimbursementPacketInput,
  ReimbursementConversationMessage,
  ReimbursementDraft,
  ReimbursementExpenseDraft,
} from "@adminbot/api-contracts";
import type { ValidatedReceipt } from "./types.js";

const MAX_RECEIPTS = 12;
const MAX_RECEIPT_BYTES = 12 * 1_024 * 1_024;
const MAX_TOTAL_RECEIPT_BYTES = 36 * 1_024 * 1_024;
const MAX_EXPENSES = 30;
const MEDIA_MAGIC = {
  "application/pdf": Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
  "image/png": Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
  "image/jpeg": Uint8Array.from([0xff, 0xd8, 0xff]),
} as const;

export class ReimbursementValidationError extends Error {}

export interface ValidatedConversation {
  readonly message: string;
  readonly receipts: readonly ValidatedReceipt[];
  readonly messages: readonly ReimbursementConversationMessage[];
  readonly draft: ReimbursementDraft;
}

export function validateConversation(value: unknown): ValidatedConversation {
  const input = object(value, "request");
  allowKeys(input, ["message", "receipts", "messages", "draft"]);
  const message = requiredString(input.message, "message", 8_000);
  const receipts = validateReceipts(input.receipts);
  const messages = validateMessages(input.messages);
  const draft = validateDraft(input.draft);
  return { message, receipts, messages, draft };
}

export function validatePacketRequest(value: unknown): GenerateReimbursementPacketInput {
  const input = object(value, "request");
  allowKeys(input, ["packId", "draft"]);
  if (input.packId !== "waterloo_travel_v1") {
    throw new ReimbursementValidationError("packId is not supported");
  }
  return { packId: input.packId, draft: validateDraft(input.draft) };
}

export function missingDraftFields(draft: ReimbursementDraft): readonly string[] {
  const required: ReadonlyArray<readonly [keyof ReimbursementDraft, string]> = [
    ["claimantName", "claimant_name"],
    ["claimantEmail", "claimant_email"],
    ["claimantAddress", "claimant_address"],
    ["claimantTitle", "claimant_title"],
    ["tripTitle", "trip_title"],
    ["tripDates", "trip_dates"],
    ["tripLocation", "trip_location"],
    ["purpose", "purpose"],
    ["currency", "currency"],
  ];
  const missing = required
    .filter(([key]) => !nonEmptyString(draft[key]))
    .map(([, label]) => label);
  if (draft.currency === "OTHER" && !nonEmptyString(draft.otherCurrency)) {
    missing.push("other_currency");
  }
  if (draft.expenses.length === 0) missing.push("expenses");
  else if (draft.expenses.some(incompleteExpense)) missing.push("complete_expense_details");
  return missing;
}

export function applyDerivedFields(draft: ReimbursementDraft): ReimbursementDraft {
  const next = { ...draft, expenses: draft.expenses.map((expense) => ({ ...expense })) };
  if (!nonEmptyString(next.currency)) {
    const totals = new Map<string, number>();
    for (const expense of next.expenses) {
      if (!nonEmptyString(expense.currency) || typeof expense.amount !== "number") continue;
      const currency = expense.currency.trim().toUpperCase();
      totals.set(currency, (totals.get(currency) ?? 0) + expense.amount);
    }
    const dominantCurrency = [...totals].sort((left, right) => right[1] - left[1])[0]?.[0];
    if (dominantCurrency !== undefined) next.currency = dominantCurrency;
  }
  if (!nonEmptyString(next.tripDates)) {
    const dates = next.expenses
      .map(({ date }) => date)
      .filter((date): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date))
      .toSorted();
    const first = dates[0];
    const last = dates.at(-1);
    if (first !== undefined && last !== undefined) {
      next.tripDates = first === last ? first : `${first} to ${last}`;
    }
  }
  return next;
}

export function packetWarnings(draft: ReimbursementDraft): readonly string[] {
  const currencies = new Set(draft.expenses.map(({ currency }) => currency).filter(nonEmptyString));
  return [
    ...(currencies.size > 1
      ? ["The packet contains multiple currencies. No currency conversion was performed."]
      : []),
    ...(draft.expenses.length === MAX_EXPENSES
      ? ["The packet uses every available expense row. Verify that no receipts are missing."]
      : []),
  ];
}

function validateReceipts(value: unknown): readonly ValidatedReceipt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RECEIPTS) {
    throw new ReimbursementValidationError(`receipts must contain at most ${MAX_RECEIPTS} files`);
  }
  let totalBytes = 0;
  return value.map((raw, index) => {
    const receipt = object(raw, `receipt ${index + 1}`);
    allowKeys(receipt, ["filename", "mediaType", "dataBase64"]);
    const filename = safeFilename(requiredString(receipt.filename, "receipt filename", 160), index);
    const mediaType = receipt.mediaType;
    if (!(typeof mediaType === "string" && mediaType in MEDIA_MAGIC)) {
      throw new ReimbursementValidationError(`receipt ${index + 1} must be a PDF, PNG, or JPEG`);
    }
    const encoded = requiredString(receipt.dataBase64, "receipt data", 20_000_000);
    const data = Uint8Array.from(Buffer.from(encoded, "base64"));
    const canonical = Buffer.from(data).toString("base64").replace(/=+$/u, "");
    if (canonical !== encoded.replace(/\s/gu, "").replace(/=+$/u, "")) {
      throw new ReimbursementValidationError(`receipt ${index + 1} is not valid base64`);
    }
    if (data.byteLength > MAX_RECEIPT_BYTES) {
      throw new ReimbursementValidationError(`receipt ${index + 1} exceeds 12 MB`);
    }
    totalBytes += data.byteLength;
    if (totalBytes > MAX_TOTAL_RECEIPT_BYTES) {
      throw new ReimbursementValidationError("receipt uploads exceed 36 MB in total");
    }
    const magic = MEDIA_MAGIC[mediaType as keyof typeof MEDIA_MAGIC];
    if (!magic.every((byte, offset) => data[offset] === byte)) {
      throw new ReimbursementValidationError(`receipt ${index + 1} content does not match its media type`);
    }
    return { filename, mediaType: mediaType as keyof typeof MEDIA_MAGIC, data };
  });
}

function validateMessages(value: unknown): readonly ReimbursementConversationMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new ReimbursementValidationError("messages must contain at most 20 entries");
  }
  return value.map((raw, index) => {
    const message = object(raw, `message ${index + 1}`);
    allowKeys(message, ["role", "content"]);
    if (message.role !== "user" && message.role !== "assistant") {
      throw new ReimbursementValidationError(`message ${index + 1} role is invalid`);
    }
    return {
      role: message.role,
      content: requiredString(message.content, `message ${index + 1} content`, 8_000),
    };
  });
}

export function validateDraft(value: unknown): ReimbursementDraft {
  if (value === undefined) return { expenses: [] };
  const draft = object(value, "draft");
  const scalarKeys = [
    "claimantName", "claimantEmail", "claimantAddress", "claimantTitle", "personnelNumber",
    "travelPeriod", "purpose", "currency", "otherCurrency", "tripTitle", "tripDates",
    "tripLocation",
  ] as const;
  allowKeys(draft, [...scalarKeys, "expenses"]);
  const expenses = draft.expenses;
  if (!Array.isArray(expenses) || expenses.length > MAX_EXPENSES) {
    throw new ReimbursementValidationError(`draft expenses must contain at most ${MAX_EXPENSES} rows`);
  }
  return {
    expenses: expenses.map(validateExpense),
    ...Object.fromEntries(
      scalarKeys.flatMap((key) => {
        const item = draft[key];
        return item == null ? [] : [[key, optionalString(item, key, 2_000)]];
      }),
    ),
  } as ReimbursementDraft;
}

function validateExpense(value: unknown, index: number): ReimbursementExpenseDraft {
  const expense = object(value, `expense ${index + 1}`);
  const stringKeys = [
    "sourceReceipt", "receiptNumber", "date", "description", "category", "currency", "region", "taxRegion",
    "airfareClass",
  ] as const;
  allowKeys(expense, [...stringKeys, "amount", "includesTip", "tipAmount"]);
  const result: Record<string, unknown> = {};
  for (const key of stringKeys) {
    if (expense[key] != null) result[key] = optionalString(expense[key], key, 1_000);
  }
  validateExpenseEnum(result, "region", ["canada", "usa", "international"]);
  validateExpenseEnum(result, "taxRegion", [
    "ontario", "atlantic_canada", "other_canada", "usa_international",
  ]);
  validateExpenseEnum(result, "airfareClass", ["economy", "above_economy"]);
  for (const key of ["amount", "tipAmount", "extractedConfidence"] as const) {
    if (expense[key] != null) {
      if (typeof expense[key] !== "number" || !Number.isFinite(expense[key]) || expense[key] < 0) {
        throw new ReimbursementValidationError(`${key} must be a non-negative number`);
      }
      result[key] = expense[key];
    }
  }
  if (typeof result.extractedConfidence === "number" && result.extractedConfidence > 1) {
    throw new ReimbursementValidationError("extractedConfidence must be between zero and one");
  }
  if (expense.includesTip != null && typeof expense.includesTip !== "boolean") {
    throw new ReimbursementValidationError("includesTip must be a boolean");
  }
  if (expense.includesTip != null) result.includesTip = expense.includesTip;
  return result as ReimbursementExpenseDraft;
}

function validateExpenseEnum(
  expense: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): void {
  const value = expense[key];
  if (value !== undefined && value !== "" && !allowed.includes(value as string)) {
    throw new ReimbursementValidationError(`${key} is invalid`);
  }
}

function incompleteExpense(expense: ReimbursementExpenseDraft): boolean {
  return !(
    nonEmptyString(expense.date) &&
    nonEmptyString(expense.description) &&
    nonEmptyString(expense.category) &&
    typeof expense.amount === "number" && expense.amount > 0 &&
    nonEmptyString(expense.currency)
  );
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReimbursementValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function allowKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) {
    throw new ReimbursementValidationError("request contains an unsupported field");
  }
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new ReimbursementValidationError(`${label} is invalid`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new ReimbursementValidationError(`${label} is invalid`);
  }
  return value.trim();
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeFilename(value: string, index: number): string {
  const basename = value.split(/[\\/]/u).at(-1)?.replace(/[^a-zA-Z0-9._ -]/gu, "_").trim();
  return basename === undefined || basename.length === 0 ? `receipt-${index + 1}` : basename;
}
