// Control UI view renders exec approval screen content.
import { html, nothing } from "lit";
import { formatApprovalDisplayPath } from "../../../../src/infra/approval-display-paths.ts";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import "../components/modal-dialog.ts";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../controllers/exec-approval.ts";

const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

function renderMetaRow(label: string, value?: string | null, opts?: { path?: boolean }) {
  if (!value) {
    return nothing;
  }
  const displayValue = opts?.path ? formatApprovalDisplayPath(value) : value;
  return html`<div class="exec-approval-meta-row">
    <span>${label}</span><span>${displayValue}</span>
  </div>`;
}

function renderCommandWithSpans(request: ExecApprovalRequestPayload) {
  const commandSpans = [...(request.commandSpans ?? [])]
    .filter(
      (span) =>
        Number.isSafeInteger(span.startIndex) &&
        Number.isSafeInteger(span.endIndex) &&
        span.startIndex >= 0 &&
        span.endIndex > span.startIndex &&
        span.endIndex <= request.command.length,
    )
    .toSorted((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const accepted: typeof commandSpans = [];
  let cursor = 0;
  for (const span of commandSpans) {
    if (span.startIndex < cursor) {
      continue;
    }
    accepted.push(span);
    cursor = span.endIndex;
  }
  if (accepted.length === 0) {
    return html`<div class="exec-approval-command mono">${request.command}</div>`;
  }
  const parts = [];
  cursor = 0;
  for (const span of accepted) {
    if (span.startIndex > cursor) {
      parts.push(request.command.slice(cursor, span.startIndex));
    }
    parts.push(
      html`<mark class="exec-approval-command-span"
        >${request.command.slice(span.startIndex, span.endIndex)}</mark
      >`,
    );
    cursor = span.endIndex;
  }
  if (cursor < request.command.length) {
    parts.push(request.command.slice(cursor));
  }
  return html`<div class="exec-approval-command mono">${parts}</div>`;
}

function renderExecBody(request: ExecApprovalRequestPayload) {
  return html`
    ${renderCommandWithSpans(request)}
    <div class="exec-approval-meta">
      ${renderMetaRow(t("execApproval.labels.host"), request.host)}
      ${renderMetaRow(t("execApproval.labels.agent"), request.agentId)}
      ${renderMetaRow(t("execApproval.labels.session"), request.sessionKey)}
      ${renderMetaRow(t("execApproval.labels.cwd"), request.cwd, {
        path: true,
      })}
      ${renderMetaRow(t("execApproval.labels.resolved"), request.resolvedPath, { path: true })}
      ${renderMetaRow(t("execApproval.labels.security"), request.security)}
      ${renderMetaRow(t("execApproval.labels.ask"), request.ask)}
    </div>
  `;
}

function renderPluginBody(active: ExecApprovalRequest) {
  return html`
    ${active.pluginDescription
      ? html`<pre class="exec-approval-command mono" style="white-space:pre-wrap">
${active.pluginDescription}</pre
        >`
      : nothing}
    <div class="exec-approval-meta">
      ${renderMetaRow(t("execApproval.labels.severity"), active.pluginSeverity)}
      ${renderMetaRow(t("execApproval.labels.plugin"), active.pluginId)}
      ${renderMetaRow(t("execApproval.labels.agent"), active.request.agentId)}
      ${renderMetaRow(t("execApproval.labels.session"), active.request.sessionKey)}
    </div>
  `;
}

function renderSecretBody(state: AppViewState, active: ExecApprovalRequest) {
  return html`
    ${active.secretDescription
      ? html`<pre class="exec-approval-command mono" style="white-space:pre-wrap">
${active.secretDescription}</pre
        >`
      : nothing}
    <div class="exec-approval-meta">
      ${renderMetaRow("Variable", active.secretVariableName)}
      ${renderMetaRow(t("execApproval.labels.agent"), active.request.agentId)}
      ${renderMetaRow(t("execApproval.labels.session"), active.request.sessionKey)}
    </div>
    <input
      class="input mono"
      type="password"
      autocomplete="off"
      spellcheck="false"
      .value=${state.execApprovalSecretValue}
      @input=${(event: Event) =>
        state.handleExecApprovalSecretInput((event.target as HTMLInputElement).value)}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Enter") {
          void state.handleExecApprovalSecretSubmit();
        }
      }}
    />
  `;
}

function approvalDecisionLabel(decision: ExecApprovalDecision): string {
  switch (decision) {
    case "allow-once":
      return t("execApproval.allowOnce");
    case "allow-always":
      return t("execApproval.alwaysAllow");
    case "deny":
      return t("execApproval.deny");
  }
  return t("execApproval.deny");
}

function approvalDecisionClass(decision: ExecApprovalDecision): string {
  switch (decision) {
    case "allow-once":
      return "btn primary";
    case "allow-always":
      return "btn";
    case "deny":
      return "btn danger";
  }
  return "btn danger";
}

function resolveApprovalDecisions(active: ExecApprovalRequest): readonly ExecApprovalDecision[] {
  if (active.request.allowedDecisions?.length) {
    return active.request.allowedDecisions;
  }
  if (active.kind === "exec" && active.request.ask === "always") {
    return ["allow-once", "deny"];
  }
  return DEFAULT_EXEC_APPROVAL_DECISIONS;
}

function renderUnavailableDecisionWarning(
  active: ExecApprovalRequest,
  decisions: readonly ExecApprovalDecision[],
) {
  return active.kind !== "exec" || decisions.includes("allow-always")
    ? nothing
    : html`<div class="exec-approval-warning">${t("execApproval.allowAlwaysUnavailable")}</div>`;
}

function approvalKindLabel(request: ExecApprovalRequest): string {
  if (request.kind === "secret") {
    return "Secret";
  }
  if (request.kind === "plugin") {
    return "Plugin";
  }
  return "Exec";
}

function approvalTitle(request: ExecApprovalRequest): string {
  return (
    request.secretTitle ??
    request.pluginTitle ??
    request.request.command.split("\n", 1)[0]?.trim() ??
    request.id
  );
}

function approvalDetail(request: ExecApprovalRequest): string {
  return [request.pluginId, request.request.agentId, request.request.sessionKey]
    .filter(Boolean)
    .join(" · ");
}

function renderApprovalQueueList(queue: readonly ExecApprovalRequest[]) {
  return html`
    <div class="exec-approval-list" role="list" aria-label="Pending approvals">
      ${queue.map(
        (entry, index) => html`
          <div
            class="exec-approval-list__item ${index === 0
              ? "exec-approval-list__item--active"
              : ""}"
            role="listitem"
          >
            <span class="exec-approval-list__kind">${approvalKindLabel(entry)}</span>
            <span class="exec-approval-list__main">
              <strong>${approvalTitle(entry)}</strong>
              <small>${approvalDetail(entry) || entry.id}</small>
            </span>
          </div>
        `,
      )}
    </div>
  `;
}

export function renderExecApprovalPrompt(state: AppViewState) {
  const active = state.execApprovalQueue[0];
  if (!active) {
    return nothing;
  }
  const request = active.request;
  const queueCount = state.execApprovalQueue.length;
  const pending = t("execApproval.pending", { count: String(queueCount) });
  const isPlugin = active.kind === "plugin";
  const isSecret = active.kind === "secret";
  const title = isSecret
    ? (active.secretTitle ?? "Secret required")
    : isPlugin
      ? (active.pluginTitle ?? t("execApproval.pluginApprovalNeeded"))
      : t("execApproval.execApprovalNeeded");
  const titleId = "exec-approval-title";
  const descriptionId = "exec-approval-description";
  const decisions = resolveApprovalDecisions(active);
  const handleCancel = () => {
    if (isSecret) {
      void state.handleExecApprovalSecretCancel();
      return;
    }
    if (!state.execApprovalBusy && decisions.includes("deny")) {
      void state.handleExecApprovalDecision("deny");
    }
  };
  return html`
    <openclaw-modal-dialog label=${title} description=${pending} @modal-cancel=${handleCancel}>
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div id=${titleId} class="exec-approval-title">${title}</div>
            <div id=${descriptionId} class="exec-approval-sub">${pending}</div>
          </div>
          ${queueCount > 1
            ? html`<div class="exec-approval-queue">
                ${pending}
              </div>`
            : nothing}
        </div>
        ${renderApprovalQueueList(state.execApprovalQueue)}
        ${isSecret
          ? renderSecretBody(state, active)
          : isPlugin
            ? renderPluginBody(active)
            : renderExecBody(request)}
        ${isSecret ? nothing : renderUnavailableDecisionWarning(active, decisions)}
        ${state.execApprovalError
          ? html`<div class="exec-approval-error">${state.execApprovalError}</div>`
          : nothing}
        <div class="exec-approval-actions">
          ${isSecret
            ? html`
                <button
                  class="btn"
                  ?disabled=${state.execApprovalBusy}
                  @click=${() => state.handleExecApprovalSecretCancel()}
                >
                  Cancel
                </button>
                <button
                  class="btn primary"
                  ?disabled=${state.execApprovalBusy}
                  @click=${() => state.handleExecApprovalSecretSubmit()}
                >
                  Submit
                </button>
              `
            : decisions.map(
                (decision) => html`
                  <button
                    class=${approvalDecisionClass(decision)}
                    ?disabled=${state.execApprovalBusy}
                    @click=${() => state.handleExecApprovalDecision(decision)}
                  >
                    ${approvalDecisionLabel(decision)}
                  </button>
                `,
              )}
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
