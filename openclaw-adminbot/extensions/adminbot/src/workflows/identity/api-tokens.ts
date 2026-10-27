// Personal API tokens: minting, listing and revoking them, resolving one on a request, and the
// browser-approved `adminbot login` handshake. See docs/adminbot/api-tokens.md for the design.
//
// Separate from AdminBotAuthService, which owns passwords and browser sessions: the two share the
// store and the principal shape, and nothing else.
import { randomUUID } from "node:crypto";
import type { AdminBotAuditEvent, AdminBotPrivilegeLevel } from "../../contracts/actions.js";
import type { AdminBotApiToken } from "../../contracts/api-tokens.js";
import {
  DEVICE_LOGIN_POLL_SECONDS,
  DEVICE_LOGIN_TTL_MS,
  MemoryDeviceLoginStore,
  formatUserCode,
  hashDeviceCode,
  newDeviceCode,
  newUserCode,
  normalizeUserCode,
  type DeviceLogin,
  type DeviceLoginStore,
} from "./api-token-device-logins.js";
import {
  API_TOKEN_IDLE_REVOKE_MS,
  ApiTokenRateLimiter,
  apiTokenHint,
  apiTokenLevels,
  apiTokensAllowed,
  clampApiTokenDays,
  cleanApiTokenName,
  hashApiToken,
  isApiTokenShaped,
  mintApiTokenSecret,
  newApiTokenId,
} from "./api-token-format.js";
import {
  verifyPasswordAsync,
  type AdminBotAuthResponse,
  type AdminBotAuthStore,
  type AdminBotMemberPrincipal,
} from "./auth.js";

/**
 * Where the Control UI asks the member to approve a CLI login: My Profile, which already sends a
 * signed-out visitor through sign-in and back. The code rides in ?cliLogin=, like ?passwordReset=,
 * and the UI strips it from the address bar as soon as it has read it.
 */
export const ADMINBOT_CLI_LOGIN_PATH = "/profile";

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const SEEN_IPS_MAX = 50;
// Password re-checks (mint, approve) and user-code lookups, per member: the browser session is
// already signed in, so this only slows somebody guessing at a session they have taken over.
const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
// Anonymous `adminbot login` starts, per IP.
const DEVICE_STARTS_PER_IP = 10;
const DEVICE_START_WINDOW_MS = 10 * 60 * 1000;

type Place = { city?: string; country?: string };

export type AdminBotApiTokenStore = Pick<
  AdminBotAuthStore,
  | "getApiToken"
  | "getApiTokenByHash"
  | "getCredentialByMemberId"
  | "getLabMember"
  | "listApiTokensForMember"
  | "recordAudit"
  | "revokeApiToken"
  | "revokeApiTokensForMember"
  | "saveApiToken"
  | "touchApiToken"
>;

export type AdminBotApiTokenServiceOptions = {
  store: AdminBotApiTokenStore;
  /** ADMINBOT_API_TOKEN_LEVELS as given; see apiTokenLevels. */
  levels?: string;
  geolocateIp?: (ip: string) => Promise<Place | undefined>;
  /**
   * Fired (not awaited) the first time a token is used from an address it has not been used from.
   * Unwired by default: an email alert is a new outbound message and needs the owner's sign-off.
   */
  onApiTokenNewIp?: (event: {
    member_id: string;
    token_id: string;
    token_name: string;
    ip: string;
    place?: string;
  }) => void;
  /** The Control UI origin the CLI sends people to for approval; see resolveAdminBotControlUiUrl. */
  controlUiUrl: string;
  deviceLogins?: DeviceLoginStore;
  rateLimiter?: ApiTokenRateLimiter;
  warn?: (message: string) => void;
  now?: () => Date;
};

/** A token as its owner sees it: never the hash, never the secret. */
export type AdminBotApiTokenView = {
  id: string;
  name: string;
  hint: string;
  created_at: string;
  expires_at: string;
  created_ip?: string;
  last_used_at?: string;
  last_used_ip?: string;
  last_used_place?: string;
  ip_count: number;
  revoked_at?: string;
  revoked_reason?: string;
  /** True for the token this request was made with. */
  current?: boolean;
};

export type AdminBotApiTokenResolution =
  | { ok: true; principal: AdminBotMemberPrincipal }
  | { ok: false; status: 401 }
  | { ok: false; status: 429; retry_after_seconds: number };

export type AdminBotDeviceLoginStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type AdminBotDeviceLoginPoll =
  | { status: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" }
  | {
      status: "approved";
      token: string;
      api_token: AdminBotApiTokenView;
      member: { id: string; name: string };
    };

export class AdminBotApiTokenService {
  private readonly store: AdminBotApiTokenStore;
  private readonly levels: Set<AdminBotPrivilegeLevel>;
  private readonly geolocateIp?: AdminBotApiTokenServiceOptions["geolocateIp"];
  private readonly onApiTokenNewIp?: AdminBotApiTokenServiceOptions["onApiTokenNewIp"];
  private readonly controlUiUrl: string;
  private readonly deviceLogins: DeviceLoginStore;
  private readonly rateLimiter: ApiTokenRateLimiter;
  private readonly warn: (message: string) => void;
  private readonly now: () => Date;
  private readonly failures = new Map<string, number[]>();
  // Token+address pairs whose new-IP bookkeeping is in progress, so a burst of requests from a new
  // address writes one audit line rather than one per request.
  private readonly newIpInFlight = new Set<string>();

  constructor(options: AdminBotApiTokenServiceOptions) {
    this.store = options.store;
    this.levels = apiTokenLevels(options.levels);
    this.geolocateIp = options.geolocateIp;
    this.onApiTokenNewIp = options.onApiTokenNewIp;
    this.controlUiUrl = options.controlUiUrl.replace(/\/+$/u, "");
    this.now = options.now ?? (() => new Date());
    this.deviceLogins = options.deviceLogins ?? new MemoryDeviceLoginStore(this.now);
    this.rateLimiter = options.rateLimiter ?? new ApiTokenRateLimiter();
    this.warn = options.warn ?? ((message: string) => console.warn(message));
  }

  /** Whether this member could hold a token at all; the UI uses it to show or hide the section. */
  allowedFor(principal: AdminBotMemberPrincipal): boolean {
    return apiTokensAllowed(principal.member, this.levels);
  }

  // ---- Resolving a request ------------------------------------------------------------------

  /**
   * The member a bearer token acts as, or why not. Checked on every request, in this order: the
   * token exists and is live, it has not sat idle past the limit, its owner still exists and may
   * still hold tokens, and it is under its rate limit. A demoted owner is refused rather than
   * revoked, so restoring their level restores their tokens.
   */
  async resolve(raw: string, remoteIp: string | undefined): Promise<AdminBotApiTokenResolution> {
    if (!isApiTokenShaped(raw)) {
      return { ok: false, status: 401 };
    }
    const token = await this.store.getApiTokenByHash(hashApiToken(raw));
    const now = this.now();
    const nowIso = now.toISOString();
    if (!token || token.revoked_at || token.expires_at <= nowIso) {
      return { ok: false, status: 401 };
    }
    const lastUse = Date.parse(token.last_used_at ?? token.created_at);
    if (now.getTime() - lastUse > API_TOKEN_IDLE_REVOKE_MS) {
      if (await this.store.revokeApiToken(token.id, nowIso, "idle")) {
        await this.audit("auth.api_token.revoked", token.member_id, {
          token_id: token.id,
          name: token.name,
          reason: "idle",
        });
      }
      return { ok: false, status: 401 };
    }
    const member = await this.store.getLabMember(token.member_id);
    if (!member || !apiTokensAllowed(member, this.levels)) {
      return { ok: false, status: 401 };
    }
    const wait = this.rateLimiter.take(token.id, now.getTime());
    if (wait > 0) {
      return { ok: false, status: 429, retry_after_seconds: wait };
    }
    await this.noteUse(token, remoteIp, now);
    return {
      ok: true,
      principal: {
        kind: "member",
        member,
        session: {
          token_hash: token.token_hash,
          member_id: token.member_id,
          created_at: token.created_at,
          expires_at: token.expires_at,
          last_seen_at: nowIso,
        },
        apiToken: { id: token.id, name: token.name },
      },
    };
  }

  private async noteUse(token: AdminBotApiToken, ip: string | undefined, now: Date): Promise<void> {
    const nowIso = now.toISOString();
    const newIp = Boolean(ip) && !token.seen_ips.includes(ip!);
    const stale =
      !token.last_used_at || Date.parse(token.last_used_at) <= now.getTime() - TOUCH_INTERVAL_MS;
    if (!newIp && !stale && (!ip || token.last_used_ip === ip)) {
      return;
    }
    const seen = ip ? [ip, ...token.seen_ips.filter((s) => s !== ip)] : token.seen_ips;
    await this.store.touchApiToken(token.id, {
      last_used_at: nowIso,
      ...(ip ? { last_used_ip: ip } : {}),
      ...(token.last_used_place && !newIp ? { last_used_place: token.last_used_place } : {}),
      seen_ips: seen.slice(0, SEEN_IPS_MAX),
    });
    if (!newIp || !ip) {
      return;
    }
    const key = `${token.id}|${ip}`;
    if (this.newIpInFlight.has(key)) {
      return;
    }
    this.newIpInFlight.add(key);
    // Fire-and-forget: the request never waits on a geolocation lookup or an audit write.
    void (async () => {
      try {
        const place = placeLabel(await this.geolocateIp?.(ip).catch(() => undefined));
        if (place) {
          await this.store.touchApiToken(token.id, {
            last_used_at: nowIso,
            last_used_ip: ip,
            last_used_place: place,
            seen_ips: seen.slice(0, SEEN_IPS_MAX),
          });
        }
        // The token's first ever use is its creation address or the CLI's; still worth a line, but
        // the hook is for an address that differs from one already seen.
        await this.audit("auth.api_token.new_ip", token.member_id, {
          token_id: token.id,
          name: token.name,
          ip,
          ...(place ? { place } : {}),
          first_use: token.seen_ips.length === 0,
        });
        if (token.seen_ips.length > 0) {
          this.onApiTokenNewIp?.({
            member_id: token.member_id,
            token_id: token.id,
            token_name: token.name,
            ip,
            ...(place ? { place } : {}),
          });
        }
      } catch (error) {
        this.warn(`api token new-ip bookkeeping failed: ${errorMessage(error)}`);
      } finally {
        this.newIpInFlight.delete(key);
      }
    })();
  }

  // ---- Managing one's own tokens ------------------------------------------------------------

  async list(principal: AdminBotMemberPrincipal): Promise<AdminBotApiTokenView[]> {
    const tokens = await this.store.listApiTokensForMember(principal.member.id);
    return tokens.map((token) => toView(token, principal.apiToken?.id));
  }

  /**
   * A token made directly from My Profile, for a CI job or a machine without a browser. Requires
   * the password again: a browser left signed in should not be enough to mint a 90-day credential.
   */
  async create(
    principal: AdminBotMemberPrincipal,
    input: { name: unknown; expires_in_days: unknown; password: unknown; remoteIp?: string },
  ): Promise<AdminBotAuthResponse<{ token: string; api_token: AdminBotApiTokenView }>> {
    const refused = this.refuseMinting(principal);
    if (refused) {
      return refused;
    }
    const name = cleanApiTokenName(input.name);
    if (!name) {
      return fail(400, "a token needs a name, e.g. the machine or agent that will use it");
    }
    const checked = await this.checkPassword(principal.member.id, input.password);
    if (checked) {
      return checked;
    }
    const { secret, token } = await this.mint(principal.member.id, name, input.expires_in_days, {
      ...(input.remoteIp ? { ip: input.remoteIp } : {}),
      via: "profile",
    });
    return { ok: true, status: 201, payload: { token: secret, api_token: toView(token) } };
  }

  async revoke(
    principal: AdminBotMemberPrincipal,
    tokenId: string,
  ): Promise<AdminBotAuthResponse<{ revoked: true }>> {
    if (principal.impersonator) {
      return fail(403, "stop viewing as this member before changing their tokens");
    }
    // The route passes any path segment; only something shaped like an id reaches the store.
    const token = /^tok_[0-9a-f]{20}$/u.test(tokenId)
      ? await this.store.getApiToken(tokenId)
      : undefined;
    // Somebody else's token reads as missing, so ids cannot be probed.
    if (!token || token.member_id !== principal.member.id) {
      return fail(404, "no such token");
    }
    const at = this.now().toISOString();
    if (await this.store.revokeApiToken(token.id, at, "revoked_by_owner")) {
      await this.audit("auth.api_token.revoked", principal.member.id, {
        token_id: token.id,
        name: token.name,
        reason: "revoked_by_owner",
      });
    }
    return { ok: true, status: 200, payload: { revoked: true } };
  }

  /** Allowed with a token, so an agent that suspects a leak can pull every credential at once. */
  async revokeAll(
    principal: AdminBotMemberPrincipal,
  ): Promise<AdminBotAuthResponse<{ revoked: number }>> {
    if (principal.impersonator) {
      return fail(403, "stop viewing as this member before changing their tokens");
    }
    const revoked = await this.store.revokeApiTokensForMember(
      principal.member.id,
      this.now().toISOString(),
      "revoked_all_by_owner",
    );
    await this.audit("auth.api_token.revoked_all", principal.member.id, { revoked });
    return { ok: true, status: 200, payload: { revoked } };
  }

  // ---- `adminbot login`: browser approval ---------------------------------------------------

  /** Anonymous: the CLI has no credential yet. Rate-limited per address. */
  async startDeviceLogin(input: {
    name: unknown;
    expires_in_days: unknown;
    remoteIp?: string;
  }): Promise<AdminBotAuthResponse<AdminBotDeviceLoginStart>> {
    const name = cleanApiTokenName(input.name);
    if (!name) {
      return fail(400, "a token needs a name, e.g. the machine or agent that will use it");
    }
    const ipKey = `device-start:${input.remoteIp ?? "unknown"}`;
    const nowMs = this.now().getTime();
    const recent = this.recent(ipKey, nowMs, DEVICE_START_WINDOW_MS);
    if (recent.length >= DEVICE_STARTS_PER_IP) {
      return {
        ok: false,
        status: 429,
        error: { message: "too many sign-in requests from this address; try again later" },
        retry_after_seconds: Math.ceil((recent[0]! + DEVICE_START_WINDOW_MS - nowMs) / 1000),
      };
    }
    this.failures.set(ipKey, [...recent, nowMs]);
    const deviceCode = newDeviceCode();
    const created = this.now();
    let userCode = newUserCode();
    const login = (code: string): DeviceLogin => ({
      device_code_hash: hashDeviceCode(deviceCode),
      user_code: code,
      name,
      expires_in_days: clampApiTokenDays(input.expires_in_days),
      ...(input.remoteIp ? { requested_ip: input.remoteIp } : {}),
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + DEVICE_LOGIN_TTL_MS).toISOString(),
      status: "pending",
    });
    // A user-code collision is ~1 in 10^10; one retry with a fresh code is plenty.
    if (!this.deviceLogins.add(login(userCode))) {
      userCode = newUserCode();
      if (!this.deviceLogins.add(login(userCode))) {
        return fail(503, "too many sign-ins are waiting for approval; try again in a few minutes");
      }
    }
    await this.audit("auth.api_token.cli_login_started", undefined, {
      name,
      ...(input.remoteIp ? { ip: input.remoteIp } : {}),
    });
    const shown = formatUserCode(userCode);
    const base = `${this.controlUiUrl}${ADMINBOT_CLI_LOGIN_PATH}`;
    return {
      ok: true,
      status: 200,
      payload: {
        device_code: deviceCode,
        user_code: shown,
        verification_uri: base,
        verification_uri_complete: `${base}?${new URLSearchParams({ cliLogin: shown })}`,
        expires_in: DEVICE_LOGIN_TTL_MS / 1000,
        interval: DEVICE_LOGIN_POLL_SECONDS,
      },
    };
  }

  /** What the approval page shows before asking for the password. */
  async describeDeviceLogin(
    principal: AdminBotMemberPrincipal,
    rawCode: unknown,
  ): Promise<
    AdminBotAuthResponse<{
      user_code: string;
      name: string;
      expires_in_days: number;
      requested_ip?: string;
      created_at: string;
      expires_at: string;
    }>
  > {
    const refused = this.refuseMinting(principal);
    if (refused) {
      return refused;
    }
    const found = this.pendingLogin(principal.member.id, rawCode);
    if (!found.ok) {
      return found;
    }
    const login = found.payload;
    return {
      ok: true,
      status: 200,
      payload: {
        user_code: formatUserCode(login.user_code),
        name: login.name,
        expires_in_days: login.expires_in_days,
        ...(login.requested_ip ? { requested_ip: login.requested_ip } : {}),
        created_at: login.created_at,
        expires_at: login.expires_at,
      },
    };
  }

  async approveDeviceLogin(
    principal: AdminBotMemberPrincipal,
    input: { user_code: unknown; password: unknown },
  ): Promise<AdminBotAuthResponse<{ approved: true }>> {
    const refused = this.refuseMinting(principal);
    if (refused) {
      return refused;
    }
    const found = this.pendingLogin(principal.member.id, input.user_code);
    if (!found.ok) {
      return found;
    }
    const checked = await this.checkPassword(principal.member.id, input.password);
    if (checked) {
      return checked;
    }
    found.payload.status = "approved";
    found.payload.member_id = principal.member.id;
    return { ok: true, status: 200, payload: { approved: true } };
  }

  async denyDeviceLogin(
    principal: AdminBotMemberPrincipal,
    rawCode: unknown,
  ): Promise<AdminBotAuthResponse<{ denied: true }>> {
    const found = this.pendingLogin(principal.member.id, rawCode);
    if (!found.ok) {
      return found;
    }
    found.payload.status = "denied";
    await this.audit("auth.api_token.cli_login_denied", principal.member.id, {
      name: found.payload.name,
      ...(found.payload.requested_ip ? { ip: found.payload.requested_ip } : {}),
    });
    return { ok: true, status: 200, payload: { denied: true } };
  }

  /**
   * The CLI asking whether its request was approved. The token is minted here, on the first poll
   * after approval, and the request is then forgotten: the secret exists once, in this response.
   */
  async pollDeviceLogin(deviceCode: unknown): Promise<AdminBotAuthResponse<AdminBotDeviceLoginPoll>> {
    if (typeof deviceCode !== "string" || !deviceCode) {
      return fail(400, "device_code is required");
    }
    const hash = hashDeviceCode(deviceCode);
    const login = this.deviceLogins.byDeviceCodeHash(hash);
    const ok = (payload: AdminBotDeviceLoginPoll): AdminBotAuthResponse<AdminBotDeviceLoginPoll> => ({
      ok: true,
      status: 200,
      payload,
    });
    if (!login) {
      return ok({ status: "expired_token" });
    }
    if (login.status === "denied") {
      this.deviceLogins.remove(hash);
      return ok({ status: "access_denied" });
    }
    if (login.status === "pending") {
      const nowMs = this.now().getTime();
      const tooSoon =
        login.last_polled_ms !== undefined &&
        nowMs - login.last_polled_ms < (DEVICE_LOGIN_POLL_SECONDS * 1000) / 2;
      login.last_polled_ms = nowMs;
      return ok({ status: tooSoon ? "slow_down" : "authorization_pending" });
    }
    this.deviceLogins.remove(hash);
    const member = login.member_id ? await this.store.getLabMember(login.member_id) : undefined;
    // Demoted or removed between approving and collecting: the approval no longer stands.
    if (!member || !apiTokensAllowed(member, this.levels)) {
      return ok({ status: "access_denied" });
    }
    const { secret, token } = await this.mint(member.id, login.name, login.expires_in_days, {
      ...(login.requested_ip ? { ip: login.requested_ip } : {}),
      via: "cli_login",
    });
    return ok({
      status: "approved",
      token: secret,
      api_token: toView(token),
      member: { id: member.id, name: member.name },
    });
  }

  // ---- Internals ----------------------------------------------------------------------------

  /** Why this principal may not mint a token (or approve a sign-in that mints one), if it may not. */
  private refuseMinting(principal: AdminBotMemberPrincipal): AdminBotAuthResponse<never> | undefined {
    if (principal.apiToken) {
      // A leaked token must not be able to make itself permanent by minting a successor.
      return fail(403, "an API token cannot create tokens; sign in to AdminBot in a browser");
    }
    if (principal.impersonator) {
      return fail(403, "stop viewing as this member before creating tokens");
    }
    if (!apiTokensAllowed(principal.member, this.levels)) {
      return fail(403, "API tokens are not available for your account");
    }
    return undefined;
  }

  private pendingLogin(
    memberId: string,
    rawCode: unknown,
  ): AdminBotAuthResponse<DeviceLogin> {
    const limited = this.failureLimited(memberId);
    if (limited) {
      return limited;
    }
    const code = normalizeUserCode(rawCode);
    const login = code ? this.deviceLogins.byUserCode(code) : undefined;
    if (!login || login.status !== "pending") {
      this.noteFailure(memberId);
      return fail(404, "that code is unknown or has expired; run adminbot login again");
    }
    return { ok: true, status: 200, payload: login };
  }

  private async checkPassword(
    memberId: string,
    password: unknown,
  ): Promise<AdminBotAuthResponse<never> | undefined> {
    const limited = this.failureLimited(memberId);
    if (limited) {
      return limited;
    }
    const credential = await this.store.getCredentialByMemberId(memberId);
    if (
      typeof password !== "string" ||
      !credential ||
      !(await verifyPasswordAsync(credential.password_scrypt, password))
    ) {
      this.noteFailure(memberId);
      return fail(401, "password is incorrect");
    }
    return undefined;
  }

  private async mint(
    memberId: string,
    name: string,
    days: unknown,
    origin: { ip?: string; via: "profile" | "cli_login" },
  ): Promise<{ secret: string; token: AdminBotApiToken }> {
    const secret = mintApiTokenSecret();
    const created = this.now();
    const token: AdminBotApiToken = {
      id: newApiTokenId(),
      token_hash: hashApiToken(secret),
      member_id: memberId,
      name,
      hint: apiTokenHint(secret),
      scopes: ["*"],
      created_at: created.toISOString(),
      expires_at: new Date(
        created.getTime() + clampApiTokenDays(days) * 24 * 60 * 60 * 1000,
      ).toISOString(),
      ...(origin.ip ? { created_ip: origin.ip } : {}),
      seen_ips: [],
    };
    await this.store.saveApiToken(token);
    await this.audit("auth.api_token.created", memberId, {
      token_id: token.id,
      name,
      expires_at: token.expires_at,
      via: origin.via,
      ...(origin.ip ? { ip: origin.ip } : {}),
    });
    return { secret, token };
  }

  private failureLimited(memberId: string): AdminBotAuthResponse<never> | undefined {
    const nowMs = this.now().getTime();
    const recent = this.recent(`member:${memberId}`, nowMs, FAILURE_WINDOW_MS);
    if (recent.length < FAILURE_LIMIT) {
      return undefined;
    }
    return {
      ok: false,
      status: 429,
      error: { message: "too many failed attempts; try again later" },
      retry_after_seconds: Math.ceil((recent[0]! + FAILURE_WINDOW_MS - nowMs) / 1000),
    };
  }

  private noteFailure(memberId: string): void {
    const key = `member:${memberId}`;
    const nowMs = this.now().getTime();
    this.failures.set(key, [...this.recent(key, nowMs, FAILURE_WINDOW_MS), nowMs]);
  }

  private recent(key: string, nowMs: number, windowMs: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => at > nowMs - windowMs);
    if (kept.length) {
      this.failures.set(key, kept);
    } else {
      this.failures.delete(key);
    }
    return kept;
  }

  private async audit(
    type: AdminBotAuditEvent["type"],
    actor: string | undefined,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.store.recordAudit({
      id: `aud_${randomUUID()}`,
      timestamp: this.now().toISOString(),
      type,
      ...(actor ? { actor } : {}),
      details,
    });
  }
}

function toView(token: AdminBotApiToken, currentId?: string): AdminBotApiTokenView {
  return {
    id: token.id,
    name: token.name,
    hint: token.hint,
    created_at: token.created_at,
    expires_at: token.expires_at,
    ...(token.created_ip ? { created_ip: token.created_ip } : {}),
    ...(token.last_used_at ? { last_used_at: token.last_used_at } : {}),
    ...(token.last_used_ip ? { last_used_ip: token.last_used_ip } : {}),
    ...(token.last_used_place ? { last_used_place: token.last_used_place } : {}),
    ip_count: token.seen_ips.length,
    ...(token.revoked_at ? { revoked_at: token.revoked_at } : {}),
    ...(token.revoked_reason ? { revoked_reason: token.revoked_reason } : {}),
    ...(currentId && currentId === token.id ? { current: true } : {}),
  };
}

function placeLabel(place: Place | undefined): string | undefined {
  const parts = [place?.city, place?.country].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(", ") : undefined;
}

function fail(status: number, message: string): AdminBotAuthResponse<never> {
  return { ok: false, status, error: { message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
