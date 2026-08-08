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
  ErrorResponse,
  RegistrationSubmitted,
  SignupProfile,
  SignupRegistrationInput,
} from "./dtos.js";
export type {
  HttpMethod,
  RegistrationDecisionRoute,
  StaticApiRoute,
} from "./routes.js";
