// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  BrowserFormError,
  claimInputFromForm,
  signupInputFromForm,
} from "./registration-form-data.js";

describe("registration form mapping", () => {
  it("maps the complete signup form without sending empty fields", () => {
    const form = formWith({
      displayName: "Synthetic Applicant",
      email: "applicant@example.com",
      password: "correct horse battery staple",
      passwordConfirmation: "correct horse battery staple",
      researchTopics: "privacy, systems, privacy",
      hoursPerWeek: "20",
      timezone: "Europe/London",
      notes: "",
    });

    expect(signupInputFromForm(form)).toEqual({
      email: "applicant@example.com",
      password: "correct horse battery staple",
      profile: {
        displayName: "Synthetic Applicant",
        researchTopics: ["privacy", "systems"],
        hoursPerWeek: 20,
        timezone: "Europe/London",
      },
    });
  });

  it("requires an explicit roster choice and matching passwords", () => {
    const missingPerson = formWith({
      personId: "",
      email: "member@example.com",
      password: "correct horse battery staple",
      passwordConfirmation: "correct horse battery staple",
    });
    const mismatch = formWith({
      personId: "20000000-0000-4000-8000-000000000001",
      email: "member@example.com",
      password: "correct horse battery staple",
      passwordConfirmation: "different password",
    });

    expect(() => claimInputFromForm(missingPerson)).toThrow(BrowserFormError);
    expect(() => claimInputFromForm(mismatch)).toThrow("The passwords do not match.");
  });
});

function formWith(values: Readonly<Record<string, string>>): HTMLFormElement {
  const form = document.createElement("form");
  for (const [name, value] of Object.entries(values)) {
    const input = document.createElement("input");
    input.name = name;
    input.value = value;
    form.append(input);
  }
  return form;
}
