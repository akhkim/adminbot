// Which Overleaf this lab writes on, and how to name one of its projects safely.
//
// Two hosts rather than one, and the pair is the point. The lab runs its own Overleaf -- the
// instance PaperMentor is built into -- and that is where a paper has to live to be reviewed
// before submission. Drafts still arrive on overleaf.com from collaborators who started them
// there, so both are accepted as evidence and the difference is recorded rather than refused: a
// project on overleaf.com is a real draft that PaperMentor cannot see, which is a thing to say to
// its author, not a link to reject.
//
// The project reference below is the boundary every later caller has to go through. A member types
// the URL, so nothing may fetch it: the rule the slot validator states -- shape only, never a
// liveness fetch -- is what stops a typed address becoming a request the service makes. What is
// safe is the *id*, checked against a closed charset and used against an origin this deployment
// configured. Addressing PaperMentor as "project <id> on the lab's own instance" is a different
// act from following a link somebody pasted, and only the first one happens here.

/** Overleaf's own hosted service. Always accepted: half the lab's drafts start there. */
export const OVERLEAF_COM_HOST = "overleaf.com";

/**
 * The lab's own Overleaf, where PaperMentor lives.
 *
 * A literal, like every other host in the slot registry (`docs.google.com`, `arxiv.org`) and like
 * the Control UI's own origin: it is this lab's public domain, not a credential, and naming it
 * here is what lets the Control UI validate a link identically without a config channel to the
 * browser. `ADMINBOT_OVERLEAF_URL` overrides it for a deployment that runs its own.
 */
export const ADMINBOT_LAB_OVERLEAF_HOST = "overleaf.safe.eu";

export const ADMINBOT_OVERLEAF_URL_ENV = "ADMINBOT_OVERLEAF_URL";

/**
 * Overleaf project ids are 24-character hex, and the self-hosted instance is the same codebase.
 *
 * The charset is the whole guard, and it is deliberately not a length rule: this value is pasted
 * into a URL the service itself calls, so what matters is that nothing in it can escape a path
 * segment -- no slash, no dot, no percent-encoding. A minimum length would add no safety and
 * would refuse a fork that mints its ids some other way.
 */
const PROJECT_ID = /^[A-Za-z0-9]{1,64}$/u;

/**
 * Env is read through a guard rather than a `process.env` default parameter.
 *
 * This module is imported by the Control UI as well as the service -- the slot registry is shared
 * code -- and a bare `process.env` in a browser bundle is a ReferenceError at the moment somebody
 * types a link into the paper grid. The browser simply sees no configuration and falls back to the
 * literals above, which are the right answer for this deployment.
 */
function currentEnv(): NodeJS.ProcessEnv {
  return typeof process === "undefined" ? {} : (process.env ?? {});
}

/** A host, from either a full origin or a bare hostname, lowercased. Empty when it parses as neither. */
function hostOf(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** This deployment's own Overleaf host: `ADMINBOT_OVERLEAF_URL` when set, the lab's otherwise. */
export function resolveAdminBotLabOverleafHost(env: NodeJS.ProcessEnv = currentEnv()): string {
  return hostOf(env[ADMINBOT_OVERLEAF_URL_ENV] ?? "") || ADMINBOT_LAB_OVERLEAF_HOST;
}

/**
 * Every Overleaf host a project link may be on.
 *
 * overleaf.com is not configurable and never drops out: a deployment that names its own instance
 * has not stopped collaborating with people who use the hosted one.
 */
export function adminBotOverleafHosts(
  env: NodeJS.ProcessEnv = currentEnv(),
): readonly [string, string] | readonly [string] {
  const lab = resolveAdminBotLabOverleafHost(env);
  return lab === OVERLEAF_COM_HOST ? [OVERLEAF_COM_HOST] : [OVERLEAF_COM_HOST, lab];
}

/** Whether a hostname is that host or a subdomain of it -- `www.overleaf.com` is overleaf.com. */
export function isAdminBotOverleafHost(
  hostname: string,
  env: NodeJS.ProcessEnv = currentEnv(),
): boolean {
  const host = hostname.trim().toLowerCase();
  return adminBotOverleafHosts(env).some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

export type AdminBotOverleafProjectRef = {
  /** The id alone, checked against a closed charset. The only part safe to build a request from. */
  projectId: string;
  /** The origin it was found on, normalized -- no trailing slash, no path. */
  origin: string;
  host: string;
  /**
   * Whether this project is on the lab's own Overleaf, and so is one PaperMentor can review.
   *
   * The reason this type carries a flag rather than the caller re-deriving it: "can PaperMentor
   * see this paper" is the question the whole review requirement turns on, and a second copy of
   * the host comparison somewhere downstream is a second place for it to drift.
   */
  lab: boolean;
};

/**
 * The project a member's Overleaf link names, or nothing when the link is not one.
 *
 * Accepts the editor URL (`/project/<id>`) only. A read-only `/read/<token>` link names a share
 * token rather than a project id, and PaperMentor cannot be addressed with one -- returning it
 * here as though it were a project would put a token where an id is expected.
 */
export function adminBotOverleafProjectRef(
  raw: string,
  env: NodeJS.ProcessEnv = currentEnv(),
): AdminBotOverleafProjectRef | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (!isAdminBotOverleafHost(host, env)) {
    return undefined;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const at = segments.indexOf("project");
  const projectId = at === -1 ? undefined : segments[at + 1];
  if (!projectId || !PROJECT_ID.test(projectId)) {
    return undefined;
  }
  const labHost = resolveAdminBotLabOverleafHost(env);
  return {
    projectId,
    origin: url.origin,
    host,
    lab: host === labHost || host.endsWith(`.${labHost}`),
  };
}
