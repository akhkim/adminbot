import "@typespec/http";
import "../common/primitives.tsp";
import "../common/errors.tsp";
import "./automation.tsp";
import "./capabilities.tsp";
import "./governance.tsp";
import "./identity.tsp";
import "./privacy.tsp";
import "./supporting.tsp";
import "../workflows/communications.tsp";
import "../workflows/availability.tsp";
import "../workflows/papers.tsp";
import "../workflows/reimbursements.tsp";

using TypeSpec.Http;
using AdminBot.Contracts.Automation;
using AdminBot.Contracts.Capabilities;
using AdminBot.Contracts.Common;
using AdminBot.Contracts.Governance;
using AdminBot.Contracts.Identity;
using AdminBot.Contracts.Privacy;
using AdminBot.Contracts.Supporting;
using AdminBot.Contracts.Workflows.Communications;
using AdminBot.Contracts.Workflows.Availability;
using AdminBot.Contracts.Workflows.Papers;
using AdminBot.Contracts.Workflows.Reimbursements;

@service(#{ title: "AdminBot v2" })
@route("/v0alpha")
namespace AdminBot.Api.V0Alpha;

model RegistrationAcceptedResponse {
  @statusCode statusCode: 202;
  @body body: RegistrationSubmitted;
}

@route("/auth")
interface AuthenticationApi {
  @route("/roster")
  @get
  listClaimablePeople(): ClaimablePerson[] | ErrorResponse;

  @route("/registrations/claims")
  @post
  submitClaim(@body input: ClaimRegistrationInput):
    | RegistrationAcceptedResponse
    | ErrorResponse;

  @route("/registrations/signups")
  @post
  submitSignup(@body input: SignupRegistrationInput):
    | RegistrationAcceptedResponse
    | ErrorResponse;

  @route("/registrations")
  @get
  listRegistrations(@query state?: RegistrationState):
    | Registration[]
    | ErrorResponse;

  @route("/registrations/{registrationId}/decision")
  @post
  decideRegistration(
    @path registrationId: RegistrationId,
    @body input: RegistrationDecisionInput,
  ): Registration | ErrorResponse;

  @route("/sessions")
  @post
  createSession(@body input: LoginInput): SessionView | ErrorResponse;

  @route("/sessions/current")
  @get
  getCurrentSession(): SessionView | ErrorResponse;

  @route("/sessions/current")
  @delete
  deleteCurrentSession(): void | ErrorResponse;

  @route("/password")
  @post
  changePassword(@body input: PasswordChangeInput): void | ErrorResponse;

  @route("/email")
  @post
  changeEmail(@body input: EmailChangeInput): Account | ErrorResponse;

  @route("/device-credentials")
  @post
  issueDeviceCredential(@body input: DeviceCredentialInput):
    | DeviceCredentialReceipt
    | ErrorResponse;
}

@route("/me")
interface CurrentPrincipalApi {
  @get getCurrentPrincipal(): ResolvedIdentity | ErrorResponse;
}

@route("/papers")
interface PapersApi {
  @get listPapers(): PaperWorkspaceProjection | ErrorResponse;

  @post createPaper(@body input: CreatePaperCommand):
    | PaperProjection
    | ErrorResponse;

  @route("/{paperId}")
  @post
  updatePaper(@path paperId: PaperId, @body input: UpdatePaperCommand):
    | PaperProjection
    | ErrorResponse;

  @route("/{paperId}/deletion")
  @post
  deletePaper(@path paperId: PaperId, @body input: DeletePaperCommand):
    | void
    | ErrorResponse;
}

@route("/availability")
interface AvailabilityApi {
  @get getAvailabilityWorkspace():
    | AvailabilityWorkspaceProjection
    | ErrorResponse;

  @post replaceAvailabilityPlan(@body input: ReplaceAvailabilityPlanCommand):
    | AvailabilityWorkspaceProjection
    | ErrorResponse;
}

@route("/reimbursements")
interface ReimbursementsApi {
  @route("/conversation")
  @post
  converse(@body input: ReimbursementConversationInput):
    | ReimbursementConversationResult
    | ErrorResponse;

  @route("/packet")
  @post
  generatePacket(@body input: GenerateReimbursementPacketInput):
    | ReimbursementPacketResult
    | ErrorResponse;
}

@route("/capabilities")
interface CapabilitiesApi {
  @get listCapabilities(@query audience?: Audience):
    | RegisteredCapability[]
    | ErrorResponse;
}

@route("/commands")
interface CommandsApi {
  @route("/{commandName}")
  @post
  dispatchCommand(
    @path commandName: CommandName,
    @body request: CommandRequest,
  ): CommandReceipt | ErrorResponse;

  /** Typed vertical slice proving one workflow schema through the generated HTTP contract. */
  @route("/communications.create-calendar-event")
  @post
  proposeCalendarEvent(
    @header("idempotency-key") idempotencyKey: IdempotencyKey,
    @body request: CreateCalendarEventCommand,
  ): Action | ErrorResponse;
}

@route("/actions")
interface ActionsApi {
  @post proposeAction(@body proposal: ActionProposal): Action | ErrorResponse;

  @route("/{actionId}")
  @get
  getAction(@path actionId: ActionId): Action | ErrorResponse;

  @get
  listActions(
    @query state?: string,
    @query cursor?: string,
    @query limit?: int32,
  ): Page<Action> | ErrorResponse;

  @route("/{actionId}/decisions")
  @post
  decideAction(@path actionId: ActionId, @body input: ApprovalInput):
    | Action
    | ErrorResponse;

  @route("/{actionId}/executions")
  @post
  executeAction(@path actionId: ActionId): Execution | ErrorResponse;

  @route("/{actionId}/cancellations")
  @post
  cancelAction(@path actionId: ActionId, @body input: CancelActionInput):
    | Action
    | ErrorResponse;
}

model CancelActionInput {
  reason: string;
}

@route("/reasoning/tasks")
interface ReasoningApi {
  @post runReasoningTask(@body task: ReasoningTask):
    | ReasoningReceipt
    | ErrorResponse;
}

@route("/audit/events")
interface AuditApi {
  @get
  listAuditEvents(@query cursor?: string, @query limit?: int32):
    | Page<AuditEvent>
    | ErrorResponse;
}

@route("/jobs")
interface JobsApi {
  @get listJobs(@query state?: string): JobRun[] | ErrorResponse;
}
