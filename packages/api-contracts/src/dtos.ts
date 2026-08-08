import type { components } from "./generated/openapi.js";

type Schemas = components["schemas"];

export type AdministratorPolicySettings = Schemas["AdminBot.Contracts.Policy.AdministratorPolicySettings"];
export type ReplaceAdministratorPolicySettingsCommand = Schemas["AdminBot.Contracts.Policy.ReplaceAdministratorPolicySettingsCommand"];
export type GovernedActionProjection = Schemas["AdminBot.Contracts.Governance.GovernedActionProjection"];
export type GovernanceWorkspaceProjection = Schemas["AdminBot.Contracts.Governance.GovernanceWorkspaceProjection"];
export type DecideGovernedActionCommand = Schemas["AdminBot.Contracts.Governance.DecideGovernedActionCommand"];
export type ExecuteGovernedActionCommand = Schemas["AdminBot.Contracts.Governance.ExecuteGovernedActionCommand"];
export type ProposeReimbursementSubmissionCommand = Schemas["AdminBot.Contracts.Workflows.Reimbursements.ProposeReimbursementSubmissionCommand"];

export type AvailabilityEntry = Schemas["AdminBot.Contracts.Workflows.Availability.AvailabilityEntry"];
export type AvailabilityPlan = Schemas["AdminBot.Contracts.Workflows.Availability.AvailabilityPlan"];
export type AvailabilitySummary = Schemas["AdminBot.Contracts.Workflows.Availability.AvailabilitySummary"];
export type AvailabilityWorkspaceProjection = Schemas["AdminBot.Contracts.Workflows.Availability.AvailabilityWorkspaceProjection"];
export type ReplaceAvailabilityPlanCommand = Schemas["AdminBot.Contracts.Workflows.Availability.ReplaceAvailabilityPlanCommand"];

export type ClaimRegistrationInput =
  Schemas["AdminBot.Contracts.Identity.ClaimRegistrationInput"];
export type ClaimablePerson = Schemas["AdminBot.Contracts.Identity.ClaimablePerson"];
export type ErrorResponse = Schemas["AdminBot.Contracts.Common.ErrorResponse"];
export type LoginInput = Schemas["AdminBot.Contracts.Identity.LoginInput"];
export type Person = Schemas["AdminBot.Contracts.Identity.Person"];
export type CreatePaperCommand = Schemas["AdminBot.Contracts.Workflows.Papers.CreatePaperCommand"];
export type DeletePaperCommand = Schemas["AdminBot.Contracts.Workflows.Papers.DeletePaperCommand"];
export type PaperProjection = Schemas["AdminBot.Contracts.Workflows.Papers.PaperProjection"];
export type PaperWorkspaceProjection =
  Schemas["AdminBot.Contracts.Workflows.Papers.PaperWorkspaceProjection"];
export type UpdatePaperCommand = Schemas["AdminBot.Contracts.Workflows.Papers.UpdatePaperCommand"];
export type Registration = Schemas["AdminBot.Contracts.Identity.Registration"];
export type RegistrationDecisionInput =
  Schemas["AdminBot.Contracts.Identity.RegistrationDecisionInput"];
export type RegistrationSubmitted =
  Schemas["AdminBot.Contracts.Identity.RegistrationSubmitted"];
export type GenerateReimbursementPacketInput =
  Schemas["AdminBot.Contracts.Workflows.Reimbursements.GenerateReimbursementPacketInput"];
export type ReimbursementConversationInput =
  Schemas["AdminBot.Contracts.Workflows.Reimbursements.ReimbursementConversationInput"];
export type ReimbursementConversationMessage =
  Schemas["AdminBot.Contracts.Workflows.Reimbursements.ReimbursementConversationMessage"];
export type ReimbursementConversationResult =
  Schemas["AdminBot.Contracts.Workflows.Reimbursements.ReimbursementConversationResult"];
export type ReimbursementDraft =
  Schemas["AdminBot.Contracts.Workflows.Reimbursements.ReimbursementDraft"];
export type ReimbursementExpenseDraft =
  Schemas["AdminBot.Contracts.Workflows.Reimbursements.ReimbursementExpenseDraft"];
export type ReimbursementPacketArtifact =
  Schemas["AdminBot.Contracts.Workflows.Reimbursements.ReimbursementPacketArtifact"];
export type ReimbursementPacketResult =
  Schemas["AdminBot.Contracts.Workflows.Reimbursements.ReimbursementPacketResult"];
export type ReimbursementReceiptUpload =
  Schemas["AdminBot.Contracts.Workflows.Reimbursements.ReimbursementReceiptUpload"];
export type RoleName = Schemas["AdminBot.Contracts.Identity.RoleName"];
export type SessionView = Schemas["AdminBot.Contracts.Identity.SessionView"];
export type SignupProfile = Schemas["AdminBot.Contracts.Identity.SignupProfile"];
export type SignupRegistrationInput =
  Schemas["AdminBot.Contracts.Identity.SignupRegistrationInput"];
