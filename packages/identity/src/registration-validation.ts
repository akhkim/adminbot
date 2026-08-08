import type { RegistrationProfileRecord } from "@adminbot/ports";

const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 1_024;
const PROFILE_KEYS = new Set([
  "displayName",
  "slackUserId",
  "role",
  "affiliation",
  "researchBranch",
  "researchTopics",
  "projects",
  "hoursPerWeek",
  "location",
  "timezone",
  "personalWebsite",
  "notes",
]);

export interface ValidSignupRegistration {
  readonly email: string;
  readonly password: string;
  readonly profile: RegistrationProfileRecord;
}

export interface ValidClaimRegistration {
  readonly personId: string;
  readonly email: string;
  readonly password: string;
}

export class RegistrationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationValidationError";
  }
}

export function validateSignupRegistration(input: unknown): ValidSignupRegistration {
  const request = requireExactRecord(input, ["email", "password", "profile"], "request");
  return {
    email: normalizeEmailAddress(requireString(request.email, "email", EMAIL_MAX_LENGTH)),
    password: requirePassword(request.password),
    profile: validateProfile(request.profile),
  };
}

export function validateClaimRegistration(input: unknown): ValidClaimRegistration {
  const request = requireExactRecord(input, ["personId", "email", "password"], "request");
  const personId = requireString(request.personId, "personId", 36).trim();
  if (!isUuid(personId)) throw new RegistrationValidationError("personId must be a UUID");
  return {
    personId,
    email: normalizeEmailAddress(requireString(request.email, "email", EMAIL_MAX_LENGTH)),
    password: requirePassword(request.password),
  };
}

function validateProfile(input: unknown): RegistrationProfileRecord {
  const profile = requireRecord(input, "profile");
  for (const key of Object.keys(profile)) {
    if (!PROFILE_KEYS.has(key)) {
      throw new RegistrationValidationError("profile contains an unsupported field");
    }
  }

  const displayName = requireTrimmedString(profile.displayName, "profile.displayName", 160);
  const slackUserId = optionalTrimmedString(profile.slackUserId, "profile.slackUserId", 80);
  const role = optionalTrimmedString(profile.role, "profile.role", 160);
  const affiliation = optionalTrimmedString(profile.affiliation, "profile.affiliation", 240);
  const researchBranch = optionalTrimmedString(
    profile.researchBranch,
    "profile.researchBranch",
    160,
  );
  const researchTopics = optionalStringArray(
    profile.researchTopics,
    "profile.researchTopics",
  );
  const projects = optionalStringArray(profile.projects, "profile.projects");
  const hoursPerWeek = optionalHours(profile.hoursPerWeek);
  const location = optionalTrimmedString(profile.location, "profile.location", 240);
  const timezone = optionalTimezone(profile.timezone);
  const personalWebsite = optionalWebsite(profile.personalWebsite);
  const notes = optionalTrimmedString(profile.notes, "profile.notes", 4_000);

  return {
    displayName,
    ...(slackUserId === undefined ? {} : { slackUserId }),
    ...(role === undefined ? {} : { role }),
    ...(affiliation === undefined ? {} : { affiliation }),
    ...(researchBranch === undefined ? {} : { researchBranch }),
    ...(researchTopics === undefined ? {} : { researchTopics }),
    ...(projects === undefined ? {} : { projects }),
    ...(hoursPerWeek === undefined ? {} : { hoursPerWeek }),
    ...(location === undefined ? {} : { location }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(personalWebsite === undefined ? {} : { personalWebsite }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function normalizeEmailAddress(value: string): string {
  const email = value.trim().toLowerCase();
  const at = email.indexOf("@");
  if (
    email.length === 0 ||
    email.length > EMAIL_MAX_LENGTH ||
    at < 1 ||
    at !== email.lastIndexOf("@") ||
    at > 64
  ) {
    throw new RegistrationValidationError("email is invalid");
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local) ||
    !isDnsName(domain)
  ) {
    throw new RegistrationValidationError("email is invalid");
  }
  return email;
}

function isDnsName(value: string): boolean {
  if (value.length > 253 || !value.includes(".")) return false;
  const labels = value.split(".");
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
}

function requirePassword(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < PASSWORD_MIN_LENGTH ||
    value.length > PASSWORD_MAX_LENGTH
  ) {
    throw new RegistrationValidationError(
      `password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) {
    throw new RegistrationValidationError(`${field} must be an array of at most 64 strings`);
  }
  const normalized = value.map((item) => requireTrimmedString(item, field, 160));
  return [...new Set(normalized)];
}

function optionalHours(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 168) {
    throw new RegistrationValidationError("profile.hoursPerWeek must be between 0 and 168");
  }
  return value;
}

function optionalTimezone(value: unknown): string | undefined {
  const timezone = optionalTrimmedString(value, "profile.timezone", 100);
  if (timezone === undefined) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw new RegistrationValidationError("profile.timezone is invalid");
  }
}

function optionalWebsite(value: unknown): string | undefined {
  const website = optionalTrimmedString(value, "profile.personalWebsite", 2_048);
  if (website === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(website);
  } catch {
    throw new RegistrationValidationError("profile.personalWebsite is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RegistrationValidationError("profile.personalWebsite must use http or https");
  }
  return parsed.href;
}

function optionalTrimmedString(
  value: unknown,
  field: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  return requireTrimmedString(value, field, maximumLength);
}

function requireTrimmedString(value: unknown, field: string, maximumLength: number): string {
  const normalized = requireString(value, field, maximumLength).trim();
  if (normalized.length === 0) {
    throw new RegistrationValidationError(`${field} must not be empty`);
  }
  return normalized;
}

function requireString(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new RegistrationValidationError(`${field} must be a string of at most ${maximumLength} characters`);
  }
  return value;
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  const record = requireRecord(value, field);
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new RegistrationValidationError(`${field} contains an unsupported field`);
    }
  }
  return record;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RegistrationValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
