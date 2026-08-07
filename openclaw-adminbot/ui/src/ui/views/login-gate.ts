// Control UI view renders login gate screen content.
import { html } from "lit";
import { adminBotMemberRoles } from "../../../../extensions/adminbot/src/contracts.js";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { t } from "../../i18n/index.ts";
import type { MemberAuthFailure } from "../adminbot-auth-flow.ts";
import type { AppViewState } from "../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { isGatewayClientStoppedError } from "../gateway.ts";
import { icons } from "../icons.ts";
import { normalizeBasePath } from "../navigation.ts";
import { goToSignedOutView } from "../signed-out-view.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import { agentLogoUrl } from "./agents-utils.ts";
import {
  resolveAuthHintKind,
  resolvePairingHint,
  shouldShowInsecureContextHint,
} from "./overview-hints.ts";
import { renderSignedOutHeader } from "./signed-out-header.ts";

type LoginFailureKind =
  | "auth-failed"
  | "auth-rate-limited"
  | "pairing-required"
  | "insecure-context"
  | "origin-not-allowed"
  | "protocol-mismatch"
  | "network"
  | "member-auth-failed"
  | "member-claim-failed"
  | "member-rate-limited"
  | "member-pending-approval"
  | "adminbot-unreachable";

export type LoginFailureFeedback = {
  kind: LoginFailureKind;
  title: string;
  summary: string;
  steps: string[];
  docsHref: string;
  docsLabel: string;
  rawError: string;
};

type LoginFailureFeedbackParams = {
  connected: boolean;
  lastError: string | null;
  lastErrorCode?: string | null;
  hasToken: boolean;
  hasPassword: boolean;
  // Member (email+password) auth failure takes priority over gateway diagnostics
  // since it reflects the primary sign-in path.
  memberFailure?: MemberAuthFailure | null;
};

function resolveMemberFailureFeedback(failure: MemberAuthFailure): LoginFailureFeedback {
  if (failure.kind === "adminbot-unreachable") {
    return buildFeedback({
      kind: "adminbot-unreachable",
      rawError: "",
      titleKey: "login.failure.unreachable.title",
      summaryKey: "login.failure.unreachable.summary",
      stepKeys: ["login.failure.unreachable.stepService", "login.failure.unreachable.stepRetry"],
    });
  }
  if (failure.kind === "member-rate-limited") {
    const seconds = failure.retryAfterSeconds;
    return buildFeedback({
      kind: "member-rate-limited",
      rawError: "",
      titleKey: "login.failure.memberRateLimited.title",
      summaryKey:
        typeof seconds === "number"
          ? "login.failure.memberRateLimited.summarySeconds"
          : "login.failure.memberRateLimited.summary",
      stepKeys: ["login.failure.memberRateLimited.stepWait"],
      stepParams: { seconds: typeof seconds === "number" ? String(seconds) : "" },
    });
  }
  if (failure.kind === "member-claim-failed") {
    return buildFeedback({
      kind: "member-claim-failed",
      rawError: "",
      titleKey: "login.failure.memberClaim.title",
      summaryKey: "login.failure.memberClaim.summary",
      stepKeys: ["login.failure.memberClaim.stepPassword", "login.failure.memberClaim.stepSignIn"],
    });
  }
  if (failure.kind === "member-pending-approval") {
    return buildFeedback({
      kind: "member-pending-approval",
      rawError: "",
      titleKey: "login.failure.memberPending.title",
      summaryKey: "login.failure.memberPending.summary",
      stepKeys: ["login.failure.memberPending.stepWait", "login.failure.memberPending.stepContact"],
    });
  }
  return buildFeedback({
    kind: "member-auth-failed",
    rawError: "",
    titleKey: "login.failure.memberAuth.title",
    summaryKey: "login.failure.memberAuth.summary",
    stepKeys: ["login.failure.memberAuth.stepCredentials", "login.failure.memberAuth.stepClaim"],
  });
}

function resolveDocsLabel(href: string): string {
  if (href.includes("insecure-http")) {
    return t("login.failure.docsInsecure");
  }
  if (href.includes("device-pairing")) {
    return t("login.failure.docsPairing");
  }
  return t("login.failure.docsAuth");
}

function redactLoginFailureError(value: string): string {
  return value
    .replace(
      /([?#&])(?:access_token|auth|deviceToken|password|refresh_token|token)=([^&#\s]+)/gi,
      "$1[redacted-credential]",
    )
    .replace(/\bBearer\s+([A-Za-z0-9._~+/-]+=*)/gi, "Bearer [redacted]")
    .replace(
      /(["']?(?:access|accessToken|deviceToken|password|refresh|refreshToken|token)["']?\s*[:=]\s*)["']?[^"',\s}]+/gi,
      "$1[redacted]",
    );
}

function buildFeedback(params: {
  kind: LoginFailureKind;
  rawError: string;
  docsHref?: string;
  titleKey: string;
  summaryKey: string;
  stepKeys: string[];
  stepParams?: Record<string, string>;
}): LoginFailureFeedback {
  const docsHref = params.docsHref ?? "https://docs.openclaw.ai/web/dashboard";
  return {
    kind: params.kind,
    title: t(params.titleKey, params.stepParams),
    summary: t(params.summaryKey, params.stepParams),
    steps: params.stepKeys.map((key) => t(key, params.stepParams)),
    docsHref,
    docsLabel: resolveDocsLabel(docsHref),
    rawError: redactLoginFailureError(params.rawError),
  };
}

export function resolveLoginFailureFeedback(
  params: LoginFailureFeedbackParams,
): LoginFailureFeedback | null {
  if (params.connected) {
    return null;
  }
  if (params.memberFailure) {
    return resolveMemberFailureFeedback(params.memberFailure);
  }
  if (!params.lastError || isGatewayClientStoppedError(params.lastError)) {
    return null;
  }

  const rawError = params.lastError;
  const lastErrorCode = params.lastErrorCode ?? null;
  const lower = normalizeLowercaseStringOrEmpty(rawError);

  const pairing = resolvePairingHint(false, rawError, lastErrorCode);
  if (pairing) {
    return buildFeedback({
      kind: "pairing-required",
      rawError,
      docsHref: "https://docs.openclaw.ai/web/control-ui#device-pairing-first-connection",
      titleKey:
        pairing.kind === "scope-upgrade-pending"
          ? "login.failure.pairing.scopeTitle"
          : pairing.kind === "role-upgrade-pending"
            ? "login.failure.pairing.roleTitle"
            : pairing.kind === "metadata-upgrade-pending"
              ? "login.failure.pairing.metadataTitle"
              : "login.failure.pairing.title",
      summaryKey:
        pairing.kind === "pairing-required"
          ? "login.failure.pairing.summary"
          : "login.failure.pairing.upgradeSummary",
      stepKeys: [
        "login.failure.pairing.stepList",
        pairing.requestId
          ? "login.failure.pairing.stepApproveId"
          : "login.failure.pairing.stepApprove",
        "login.failure.pairing.stepReconnect",
      ],
      stepParams: { requestId: pairing.requestId ?? "" },
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    lower.includes("too many failed authentication attempts") ||
    lower.includes("rate limit")
  ) {
    return buildFeedback({
      kind: "auth-rate-limited",
      rawError,
      titleKey: "login.failure.rateLimited.title",
      summaryKey: "login.failure.rateLimited.summary",
      stepKeys: [
        "login.failure.rateLimited.stepStop",
        "login.failure.rateLimited.stepWait",
        "login.failure.rateLimited.stepCheckClients",
      ],
    });
  }

  if (shouldShowInsecureContextHint(false, rawError, lastErrorCode)) {
    return buildFeedback({
      kind: "insecure-context",
      rawError,
      docsHref: "https://docs.openclaw.ai/web/control-ui#insecure-http",
      titleKey: "login.failure.insecure.title",
      summaryKey: "login.failure.insecure.summary",
      stepKeys: [
        "login.failure.insecure.stepHttps",
        "login.failure.insecure.stepLocalCompat",
        "login.failure.insecure.stepAvoidDisable",
      ],
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED ||
    lower.includes("origin not allowed")
  ) {
    return buildFeedback({
      kind: "origin-not-allowed",
      rawError,
      docsHref:
        "https://docs.openclaw.ai/web/control-ui#debuggingtesting-dev-server--remote-gateway",
      titleKey: "login.failure.origin.title",
      summaryKey: "login.failure.origin.summary",
      stepKeys: [
        "login.failure.origin.stepAllowedOrigins",
        "login.failure.origin.stepFullOrigin",
        "login.failure.origin.stepRestart",
      ],
    });
  }

  if (lower.includes("protocol mismatch")) {
    return buildFeedback({
      kind: "protocol-mismatch",
      rawError,
      docsHref:
        "https://docs.openclaw.ai/web/control-ui#debuggingtesting-dev-server--remote-gateway",
      titleKey: "login.failure.protocol.title",
      summaryKey: "login.failure.protocol.summary",
      stepKeys: [
        "login.failure.protocol.stepDashboard",
        "login.failure.protocol.stepDevUi",
        "login.failure.protocol.stepRestart",
      ],
    });
  }

  const authHintKind = resolveAuthHintKind({
    connected: false,
    lastError: rawError,
    lastErrorCode,
    hasToken: params.hasToken,
    hasPassword: params.hasPassword,
  });
  if (authHintKind === "required") {
    // Gateway-token auth is now advanced/break-glass only; the primary sign-in
    // path is member email+password, so an unconfigured gateway token is
    // expected pre-login state, not a user-facing error to alarm on.
    return null;
  }
  if (authHintKind === "failed") {
    return buildFeedback({
      kind: "auth-failed",
      rawError,
      titleKey: "login.failure.authFailed.title",
      summaryKey: "login.failure.authFailed.summary",
      stepKeys: [
        "login.failure.authFailed.stepDashboard",
        "login.failure.authFailed.stepReplace",
        "login.failure.authFailed.stepMode",
      ],
    });
  }

  return buildFeedback({
    kind: "network",
    rawError,
    titleKey: "login.failure.network.title",
    summaryKey: "login.failure.network.summary",
    stepKeys: [
      "login.failure.network.stepGateway",
      "login.failure.network.stepUrl",
      "login.failure.network.stepDashboard",
    ],
  });
}

function renderLoginFailure(feedback: LoginFailureFeedback) {
  return html`
    <div
      class="callout danger login-gate__failure"
      role="alert"
      aria-live="polite"
      data-kind=${feedback.kind}
    >
      <div class="login-gate__failure-title">${feedback.title}</div>
      <div class="login-gate__failure-summary">${feedback.summary}</div>
      <ol class="login-gate__failure-steps">
        ${feedback.steps.map((step) => html`<li>${step}</li>`)}
      </ol>
      <details class="login-gate__failure-detail">
        <summary>${t("login.failure.rawError")}</summary>
        <div class="login-gate__failure-raw mono">${feedback.rawError}</div>
      </details>
      <a
        class="session-link login-gate__failure-docs"
        href=${feedback.docsHref}
        target=${EXTERNAL_LINK_TARGET}
        rel=${buildExternalLinkRel()}
        >${feedback.docsLabel}</a
      >
    </div>
  `;
}

function switchLoginMode(state: AppViewState, mode: AppViewState["loginMode"]) {
  state.loginMode = mode;
  state.memberFormError = null;
  state.memberAuthFailure = null;
  // Refresh the unclaimed roster whenever the picker becomes visible.
  if (mode === "claim") {
    void state.loadRoster();
  }
}

function renderRosterPicker(state: AppViewState) {
  const selected = state.selectedMemberId
    ? state.rosterMembers.find((member) => member.id === state.selectedMemberId)
    : null;
  if (state.selectedMemberId) {
    return html`
      <div class="field login-gate__picker">
        <span>${t("login.member.roster.label")}</span>
        <div class="login-gate__picker-selected">
          <span class="login-gate__picker-selected-name"
            >${selected?.name ?? state.selectedMemberId}</span
          >
          <button
            type="button"
            class="session-link login-gate__picker-change"
            @click=${() => {
              state.selectedMemberId = null;
            }}
          >
            ${t("login.member.roster.change")}
          </button>
        </div>
      </div>
    `;
  }
  const filter = state.rosterFilter.trim().toLowerCase();
  const matches = filter
    ? state.rosterMembers.filter((member) => member.name.toLowerCase().includes(filter))
    : state.rosterMembers;
  return html`
    <div class="field login-gate__picker">
      <span>${t("login.member.roster.label")}</span>
      <input
        type="text"
        autocomplete="off"
        spellcheck="false"
        .value=${state.rosterFilter}
        @input=${(e: Event) => {
          state.rosterFilter = (e.target as HTMLInputElement).value;
        }}
        placeholder=${t("login.member.roster.searchPlaceholder")}
      />
      ${state.rosterLoading
        ? html`<div class="login-gate__picker-empty">${t("login.member.roster.loading")}</div>`
        : state.rosterError
          ? html`<div class="login-gate__picker-error" role="alert">
              <span>${t("login.member.roster.error")}</span>
              <button
                type="button"
                class="session-link login-gate__picker-retry"
                @click=${() => void state.loadRoster()}
              >
                ${t("login.member.roster.retry")}
              </button>
            </div>`
          : matches.length === 0
            ? html`<div class="login-gate__picker-empty">${t("login.member.roster.empty")}</div>`
            : html`
                <div
                  class="login-gate__picker-list"
                  role="listbox"
                  aria-label=${t("login.member.roster.label")}
                >
                  ${matches.map(
                    (member) => html`
                      <button
                        type="button"
                        role="option"
                        aria-selected="false"
                        class="login-gate__picker-option"
                        @click=${() => {
                          state.selectedMemberId = member.id;
                          state.rosterFilter = "";
                        }}
                      >
                        ${member.name}
                      </button>
                    `,
                  )}
                </div>
              `}
    </div>
  `;
}

function renderSignupFields(state: AppViewState) {
  const field = (
    label: string,
    value: string,
    apply: (next: string) => void,
    placeholder: string,
    autocomplete = "off",
  ) => html`
    <label class="field">
      <span>${label}</span>
      <input
        type="text"
        autocomplete=${autocomplete}
        spellcheck="false"
        .value=${value}
        @input=${(e: Event) => apply((e.target as HTMLInputElement).value)}
        placeholder=${placeholder}
      />
    </label>
  `;
  const selectField = (
    label: string,
    value: string,
    apply: (next: string) => void,
    options: readonly string[],
    placeholder: string,
  ) => html`
    <label class="field">
      <span>${label}</span>
      <select .value=${value} @change=${(e: Event) => apply((e.target as HTMLSelectElement).value)}>
        <option value="" ?selected=${!value}>${placeholder}</option>
        ${options.map(
          (option) =>
            html`<option value=${option} ?selected=${value === option}>${option}</option>`,
        )}
      </select>
    </label>
  `;
  return html`
    ${field(
      t("login.member.signup.name"),
      state.memberName,
      (next) => {
        state.memberName = next;
      },
      t("login.member.signup.namePlaceholder"),
      "name",
    )}
    ${selectField(
      t("login.member.signup.role"),
      state.memberRole,
      (next) => {
        state.memberRole = next;
      },
      adminBotMemberRoles,
      t("login.member.signup.rolePlaceholder"),
    )}
    ${field(
      t("login.member.signup.affiliation"),
      state.memberAffiliation,
      (next) => {
        state.memberAffiliation = next;
      },
      t("login.member.signup.affiliationPlaceholder"),
    )}
    ${field(
      t("login.member.signup.slackUserId"),
      state.memberSlackUserId,
      (next) => {
        state.memberSlackUserId = next;
      },
      t("login.member.signup.slackUserIdPlaceholder"),
    )}
    ${field(
      t("login.member.signup.researchBranch"),
      state.memberResearchBranch,
      (next) => {
        state.memberResearchBranch = next;
      },
      t("login.member.signup.researchBranchPlaceholder"),
    )}
    ${field(
      t("login.member.signup.researchTopics"),
      state.memberResearchTopics,
      (next) => {
        state.memberResearchTopics = next;
      },
      t("login.member.signup.researchTopicsPlaceholder"),
    )}
    ${field(
      t("login.member.signup.projects"),
      state.memberProjects,
      (next) => {
        state.memberProjects = next;
      },
      t("login.member.signup.projectsPlaceholder"),
    )}
    ${field(
      t("login.member.signup.hoursPerWeek"),
      state.memberHoursPerWeek,
      (next) => {
        state.memberHoursPerWeek = next;
      },
      t("login.member.signup.hoursPerWeekPlaceholder"),
    )}
    ${field(
      t("login.member.signup.location"),
      state.memberLocation,
      (next) => {
        state.memberLocation = next;
      },
      t("login.member.signup.locationPlaceholder"),
    )}
    ${field(
      t("login.member.signup.timezone"),
      state.memberTimezone,
      (next) => {
        state.memberTimezone = next;
      },
      t("login.member.signup.timezonePlaceholder"),
    )}
    ${field(
      t("login.member.signup.personalWebsite"),
      state.memberPersonalWebsite,
      (next) => {
        state.memberPersonalWebsite = next;
      },
      t("login.member.signup.personalWebsitePlaceholder"),
    )}
    ${field(
      t("login.member.signup.notes"),
      state.memberNotes,
      (next) => {
        state.memberNotes = next;
      },
      t("login.member.signup.notesPlaceholder"),
    )}
  `;
}

function renderMemberForm(state: AppViewState) {
  const mode = state.loginMode;
  const requiresConfirm = mode !== "signin";
  const submitLabel =
    mode === "claim"
      ? t("login.member.claimSubmit")
      : mode === "signup"
        ? t("login.member.signupSubmit")
        : t("login.member.signIn");
  const workingLabel = mode === "signin" ? t("login.member.working") : t("login.member.submitting");
  // Native <form> submission keeps Enter-to-submit, mobile "go" buttons, and
  // password-manager autofill working without per-input key handlers.
  const onSubmit = (e: Event) => {
    e.preventDefault();
    if (!state.memberAuthBusy) {
      void state.submitMemberAuth();
    }
  };

  return html`
    <form class="login-gate__form" data-login-mode=${mode} @submit=${onSubmit} novalidate>
      ${mode === "claim" ? renderRosterPicker(state) : ""}
      ${mode === "signup" ? renderSignupFields(state) : ""}
      <label class="field">
        <span>${t("login.member.email")}</span>
        <input
          type="email"
          name="email"
          autocomplete="email"
          spellcheck="false"
          .value=${state.memberEmail}
          @input=${(e: Event) => {
            state.memberEmail = (e.target as HTMLInputElement).value;
          }}
          placeholder=${t("login.member.emailPlaceholder")}
        />
      </label>
      <label class="field">
        <span>${t("login.member.password")}</span>
        <div class="login-gate__secret-row">
          <input
            type=${state.loginShowMemberPassword ? "text" : "password"}
            name="password"
            autocomplete=${requiresConfirm ? "new-password" : "current-password"}
            spellcheck="false"
            .value=${state.memberPassword}
            @input=${(e: Event) => {
              state.memberPassword = (e.target as HTMLInputElement).value;
            }}
            placeholder=${t("login.member.passwordPlaceholder")}
          />
          <button
            type="button"
            class="btn btn--icon ${state.loginShowMemberPassword ? "active" : ""}"
            title=${state.loginShowMemberPassword
              ? t("login.hidePassword")
              : t("login.showPassword")}
            aria-label=${t("login.togglePasswordVisibility")}
            aria-pressed=${state.loginShowMemberPassword}
            @click=${() => {
              state.loginShowMemberPassword = !state.loginShowMemberPassword;
            }}
          >
            ${state.loginShowMemberPassword ? icons.eye : icons.eyeOff}
          </button>
        </div>
      </label>
      ${requiresConfirm
        ? html`
            <label class="field">
              <span>${t("login.member.confirmPassword")}</span>
              <input
                type=${state.loginShowMemberPassword ? "text" : "password"}
                name="confirm-password"
                autocomplete="new-password"
                spellcheck="false"
                .value=${state.memberPasswordConfirm}
                @input=${(e: Event) => {
                  state.memberPasswordConfirm = (e.target as HTMLInputElement).value;
                }}
                placeholder=${t("login.member.confirmPasswordPlaceholder")}
              />
            </label>
          `
        : ""}
      ${state.memberFormError
        ? html`<div class="login-gate__form-error" role="alert">${state.memberFormError}</div>`
        : ""}
      <button
        type="submit"
        class="btn primary login-gate__connect"
        ?disabled=${state.memberAuthBusy}
        aria-busy=${state.memberAuthBusy}
      >
        ${state.memberAuthBusy
          ? html`<span class="login-gate__spinner" aria-hidden="true"></span>`
          : ""}
        ${state.memberAuthBusy ? workingLabel : submitLabel}
      </button>
      ${mode === "claim"
        ? html`
            <button
              type="button"
              class="login-gate__mode-toggle session-link"
              @click=${() => switchLoginMode(state, "signup")}
            >
              ${t("login.member.toggleToSignup")}
            </button>
          `
        : ""}
      <button
        type="button"
        class="login-gate__mode-toggle session-link"
        @click=${() => switchLoginMode(state, mode === "signin" ? "claim" : "signin")}
      >
        ${mode === "signin" ? t("login.member.toggleToClaim") : t("login.member.toggleToSignIn")}
      </button>
    </form>
  `;
}

function renderPendingNotice(state: AppViewState) {
  return html`
    <div class="callout login-gate__pending" role="status" aria-live="polite">
      <div class="login-gate__pending-title">${t("login.pending.title")}</div>
      <div class="login-gate__pending-summary">${t("login.pending.summary")}</div>
      <button
        type="button"
        class="btn login-gate__connect"
        @click=${() => {
          state.loginPendingNotice = false;
          switchLoginMode(state, "signin");
        }}
      >
        ${t("login.pending.back")}
      </button>
    </div>
  `;
}

// Reimbursement is the one tool a claimant may need without ever having an account, so it gets an
// explicit door out of the login screen rather than being reachable only after signing in.
function renderGuestReimbursementLink(state: AppViewState) {
  return html`
    <div class="login-gate__guest">
      <button
        type="button"
        class="btn login-gate__guest-button"
        data-testid="login-guest-reimbursements"
        @click=${() => {
          goToSignedOutView(state, "guest-reimbursements");
        }}
      >
        ${t("login.guest.reimbursements")}
      </button>
      <div class="login-gate__guest-hint">${t("login.guest.reimbursementsHint")}</div>
      <button
        type="button"
        class="session-link login-gate__public-back"
        data-testid="login-continue-without-sign-in"
        @click=${() => {
          goToSignedOutView(state, "landing");
        }}
      >
        ${t("login.public.continueWithoutSignIn")}
      </button>
    </div>
  `;
}

export function renderLoginGate(state: AppViewState) {
  const basePath = normalizeBasePath(state.basePath ?? "");
  const faviconSrc = agentLogoUrl(basePath);
  const failure = resolveLoginFailureFeedback({
    connected: state.connected,
    lastError: state.lastError,
    lastErrorCode: state.lastErrorCode,
    hasToken: Boolean(state.settings.token.trim()),
    hasPassword: Boolean(state.password.trim()),
    memberFailure: state.memberAuthFailure,
  });

  return html`
    <div class="login-gate">
      ${renderSignedOutHeader(state, "back")}
      <div class="login-gate__card">
        <div class="login-gate__header">
          <img class="login-gate__logo" src=${faviconSrc} alt="OpenClaw" />
          <div class="login-gate__title">OpenClaw</div>
          <div class="login-gate__sub">${t("login.subtitle")}</div>
        </div>
        ${state.loginPendingNotice
          ? renderPendingNotice(state)
          : html`${renderMemberForm(state)} ${failure ? renderLoginFailure(failure) : ""}
            ${renderGuestReimbursementLink(state)}`}
      </div>
    </div>
  `;
}
