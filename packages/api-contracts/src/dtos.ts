import type { components } from "./generated/openapi.js";

type Schemas = components["schemas"];

export type ClaimRegistrationInput =
  Schemas["AdminBot.Contracts.Identity.ClaimRegistrationInput"];
export type ClaimablePerson = Schemas["AdminBot.Contracts.Identity.ClaimablePerson"];
export type ErrorResponse = Schemas["AdminBot.Contracts.Common.ErrorResponse"];
export type RegistrationSubmitted =
  Schemas["AdminBot.Contracts.Identity.RegistrationSubmitted"];
export type SignupProfile = Schemas["AdminBot.Contracts.Identity.SignupProfile"];
export type SignupRegistrationInput =
  Schemas["AdminBot.Contracts.Identity.SignupRegistrationInput"];
