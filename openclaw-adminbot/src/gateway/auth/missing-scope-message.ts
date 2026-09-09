// Human-readable gateway scope-denial messages.
// Scope failures are reported per-connection, not per-account: the presented scope set comes from
// the paired device's approved scopes, and a client that connects without a device identity has its
// self-declared scopes cleared. The bare `missing scope: <scope>` line could not tell those cases
// apart, so this module turns a denial into a message that names the method, what the connection
// actually presented, and the next step.
import { ADMIN_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";

/** Everything a denial site knows about a failed scope check. */
export type MissingScopeDetails = {
  /** Scope the policy resolved as required, when one could be resolved. */
  missingScope: string | undefined;
  /** Gateway method or HTTP operator method the caller attempted. */
  method?: string;
  /**
   * What the caller tried to do, when a bare method name would not explain the denial (an
   * override header, say). Takes the place of the method name in the message.
   */
  attemptedAction?: string;
  /** Operator scopes the connection presented, when the site can observe them. */
  presentedScopes?: readonly string[];
  /**
   * True when the method has no registered scope policy and only fell back to admin under
   * default-deny. Without this flag the message would claim an admin requirement the method
   * never actually declared.
   */
  unclassifiedMethod?: boolean;
};

// `unknown` keeps the leading `missing scope: <token>` shape parseable by the CLI probe classifier
// and the agent failover matcher, both of which key off that prefix.
const UNRESOLVED_SCOPE_LABEL = "unknown";

const PAIR_HINT =
  "Operator scopes are bound to a paired device, and a client that connects without a device " +
  "identity has its requested scopes cleared, so this happens to admins too. Check the device " +
  "with `openclaw devices list` or `openclaw doctor`.";

function formatScopeList(scopes: readonly string[]): string {
  return scopes.length > 0 ? scopes.join(", ") : "none";
}

function describeMethod(details: MissingScopeDetails): string {
  if (details.attemptedAction) {
    return details.attemptedAction;
  }
  return details.method ? `"${details.method}"` : "this request";
}

function describeRequirement(missingScope: string, details: MissingScopeDetails): string {
  // Write implies read, so a read denial means the connection had neither.
  if (missingScope === READ_SCOPE) {
    return `${describeMethod(details)} requires ${READ_SCOPE} (or ${WRITE_SCOPE}, which includes it)`;
  }
  return `${describeMethod(details)} requires ${missingScope}`;
}

/**
 * Builds the message body for a scope denial. Always starts with `missing scope: <scope>` so
 * existing log scrapers and error classifiers keep matching.
 */
export function formatMissingScopeMessage(details: MissingScopeDetails): string {
  const { presentedScopes, unclassifiedMethod } = details;
  const missingScope = details.missingScope;
  const label = missingScope ?? UNRESOLVED_SCOPE_LABEL;
  const prefix = `missing scope: ${label}`;

  if (!missingScope) {
    return `${prefix} — ${describeMethod(details)} was denied by gateway scope policy, but no required scope could be resolved. This is a gateway bug; please report the method name.`;
  }

  // Default-deny for an unrecognized method: the admin scope is a fallback, not a declared
  // requirement, and granting admin is almost never the right fix.
  if (unclassifiedMethod && missingScope === ADMIN_SCOPE) {
    return `${prefix} — ${describeMethod(details)} has no registered scope policy, so it is denied by default rather than actually requiring ${ADMIN_SCOPE}. Usually the method name is misspelled, or the plugin that registers it is not loaded on this gateway.`;
  }

  if (presentedScopes && presentedScopes.length === 0) {
    return `${prefix} — ${describeRequirement(missingScope, details)}, but this connection presented no operator scopes at all, so every scoped method is denied. ${PAIR_HINT}`;
  }

  if (presentedScopes) {
    return `${prefix} — ${describeRequirement(missingScope, details)}; this connection has ${formatScopeList([...presentedScopes])}. Approve ${missingScope} for the device with \`openclaw devices approve <requestId>\` and reconnect.`;
  }

  return `${prefix} — ${describeRequirement(missingScope, details)}.`;
}
