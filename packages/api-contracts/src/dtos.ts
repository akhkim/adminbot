import type { components } from "./generated/openapi.js";

type Schemas = components["schemas"];

export type ClaimRegistrationInput =
  Schemas["AdminBot.Contracts.Identity.ClaimRegistrationInput"];
export type ClaimablePerson = Schemas["AdminBot.Contracts.Identity.ClaimablePerson"];
export type ErrorResponse = Schemas["AdminBot.Contracts.Common.ErrorResponse"];
export type LoginInput = Schemas["AdminBot.Contracts.Identity.LoginInput"];
export type Person = Schemas["AdminBot.Contracts.Identity.Person"];
export type Registration = Schemas["AdminBot.Contracts.Identity.Registration"];
export type RegistrationDecisionInput =
  Schemas["AdminBot.Contracts.Identity.RegistrationDecisionInput"];
export type RegistrationSubmitted =
  Schemas["AdminBot.Contracts.Identity.RegistrationSubmitted"];
export type RoleName = Schemas["AdminBot.Contracts.Identity.RoleName"];
export type SessionView = Schemas["AdminBot.Contracts.Identity.SessionView"];
export type SignupProfile = Schemas["AdminBot.Contracts.Identity.SignupProfile"];
export type SignupRegistrationInput =
  Schemas["AdminBot.Contracts.Identity.SignupRegistrationInput"];
