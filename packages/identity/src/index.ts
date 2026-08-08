export {
  isSupportedScryptHash,
  ScryptPasswordHasher,
  type PasswordHasher,
} from "./password.js";
export {
  IdentityKeyDeriver,
  openClaimPersonKey,
  openRegistrationEmailKey,
} from "./keys.js";
export { normalizeEmailAddress, RegistrationValidationError } from "./registration-validation.js";
export {
  RegistrationService,
  type IdentityErrorBody,
  type RegistrationRequestContext,
  type RegistrationServiceOptions,
  type RegistrationSubmissionResult,
  type RegistrationSubmittedBody,
} from "./registration-service.js";
