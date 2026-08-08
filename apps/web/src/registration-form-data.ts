import type {
  ClaimRegistrationInput,
  SignupProfile,
  SignupRegistrationInput,
} from "@adminbot/api-contracts";

export class BrowserFormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserFormError";
  }
}

export function claimInputFromForm(form: HTMLFormElement): ClaimRegistrationInput {
  const data = new FormData(form);
  return {
    personId: required(data, "personId", "Choose your roster profile first."),
    email: required(data, "email", "Enter your email address."),
    password: matchingPassword(data),
  };
}

export function signupInputFromForm(form: HTMLFormElement): SignupRegistrationInput {
  const data = new FormData(form);
  const profile: SignupProfile = {
    displayName: required(data, "displayName", "Enter your name."),
    ...optionalText(data, "slackUserId"),
    ...optionalText(data, "role"),
    ...optionalText(data, "affiliation"),
    ...optionalText(data, "researchBranch"),
    ...optionalList(data, "researchTopics"),
    ...optionalList(data, "projects"),
    ...optionalNumber(data, "hoursPerWeek"),
    ...optionalText(data, "location"),
    ...optionalText(data, "timezone"),
    ...optionalText(data, "personalWebsite"),
    ...optionalText(data, "notes"),
  };
  return {
    email: required(data, "email", "Enter your email address."),
    password: matchingPassword(data),
    profile,
  };
}

function matchingPassword(data: FormData): string {
  const password = required(data, "password", "Enter a password.");
  const confirmation = required(data, "passwordConfirmation", "Confirm your password.");
  if (password.length < 10) {
    throw new BrowserFormError("Use at least 10 characters for your password.");
  }
  if (password !== confirmation) throw new BrowserFormError("The passwords do not match.");
  return password;
}

function required(data: FormData, field: string, message: string): string {
  const value = data.get(field);
  if (typeof value !== "string" || value.trim() === "") throw new BrowserFormError(message);
  return value.trim();
}

function optionalText(data: FormData, field: keyof SignupProfile): Partial<SignupProfile> {
  const value = data.get(field);
  if (typeof value !== "string" || value.trim() === "") return {};
  return { [field]: value.trim() };
}

function optionalList(data: FormData, field: keyof SignupProfile): Partial<SignupProfile> {
  const value = data.get(field);
  if (typeof value !== "string" || value.trim() === "") return {};
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length === 0 ? {} : { [field]: [...new Set(items)] };
}

function optionalNumber(data: FormData, field: keyof SignupProfile): Partial<SignupProfile> {
  const value = data.get(field);
  if (typeof value !== "string" || value.trim() === "") return {};
  const number = Number(value);
  if (!Number.isFinite(number)) throw new BrowserFormError("Hours per week must be a number.");
  return { [field]: number };
}
