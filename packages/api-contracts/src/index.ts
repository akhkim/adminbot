export {
  API_BASE_PATH,
  API_VERSION,
  apiRoutes,
  createApiUrl,
} from "./routes.js";
export { apiErrorCodes, isApiErrorCode, type ApiErrorCode } from "./errors.js";
export type {
  ClaimRegistrationInput,
  ClaimablePerson,
  CreatePaperCommand,
  DeletePaperCommand,
  ErrorResponse,
  LoginInput,
  Person,
  PaperProjection,
  PaperWorkspaceProjection,
  Registration,
  RegistrationDecisionInput,
  RegistrationSubmitted,
  RoleName,
  SessionView,
  SignupProfile,
  SignupRegistrationInput,
  UpdatePaperCommand,
} from "./dtos.js";
export type {
  ApiRoute,
  HttpMethod,
  PaperRoute,
  RegistrationDecisionRoute,
  StaticApiRoute,
} from "./routes.js";
