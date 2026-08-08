import "../common/primitives.tsp";
import "./identity.tsp";

using AdminBot.Contracts.Common;
using AdminBot.Contracts.Identity;

namespace AdminBot.Contracts.Authorization;

model AuthorizationRequest {
  actor: ActorContext;
  principal: Principal;
  permission: Permission;
  resource?: ResourceRef;
  fields?: string[];
}

model AuthorizationBasis {
  roles: RoleName[];
  relations: string[];
  ruleIds: string[];
}

model AuthorizationAllowed {
  allowed: true;
  basis: AuthorizationBasis;
  allowedFields?: string[];
}

model AuthorizationDenied {
  allowed: false;
  reasonCode: string;
  safeMessage: string;
}

union AuthorizationDecision {
  allowed: AuthorizationAllowed,
  denied: AuthorizationDenied,
}

interface AuthorizationService {
  authorize(request: AuthorizationRequest): AuthorizationDecision;
}
