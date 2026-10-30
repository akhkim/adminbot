// Which API token, if any, the current request arrived with -- so an audit line written anywhere
// below the route can say "via claude-laptop" without every handler threading it through.
//
// `actor` on an audit event stays the member id: "my edits" and the approver checks compare it to
// a member, and a token acts as its owner. The token is recorded beside it, in the details.
import { AsyncLocalStorage } from "node:async_hooks";
import type { AdminBotAuditEvent } from "../../contracts/actions.js";

export type ApiTokenAttribution = { id: string; name: string };

const storage = new AsyncLocalStorage<ApiTokenAttribution>();

export function runWithApiToken<T>(token: ApiTokenAttribution | undefined, run: () => T): T {
  return token ? storage.run(token, run) : run();
}

export function currentApiToken(): ApiTokenAttribution | undefined {
  return storage.getStore();
}

/** The event as given, or with `details.via_api_token` added when a token made the request. */
export function withApiTokenAttribution(event: AdminBotAuditEvent): AdminBotAuditEvent {
  const token = storage.getStore();
  if (!token) {
    return event;
  }
  return {
    ...event,
    details: { ...event.details, via_api_token: { id: token.id, name: token.name } },
  };
}
