import { html, nothing } from "lit";
import { formatDateMs, formatDateTimeMs } from "../../format.ts";
import type {
  WorkshopNudgeRecommendation,
  WorkshopNudgeReviewState,
  WorkshopNudgeViewPatch,
} from "../controllers/admin.ts";
import { aoeDateTimeLabel } from "../data/deadline-time.ts";

const PAGE_SIZE = 20;
type WorkshopNudgeResult = NonNullable<WorkshopNudgeReviewState["result"]>;
type WorkshopNudgeRecipient = WorkshopNudgeResult["recipients"][number];
type WorkshopNudgeUnresolved = WorkshopNudgeResult["unresolved_recipients"][number];

export type WorkshopNudgesProps = {
  state: WorkshopNudgeReviewState;
  onRefresh: () => void;
  /** Stop the pass in flight. */
  onCancelRun: () => void;
  /** Replace the pass in flight with a new one, without waiting out the server's stall window. */
  onForceRefresh: () => void;
  onToggleRecipient: (memberId: string) => void;
  onSetRecipients: (memberIds: string[], selected: boolean) => void;
  onViewChange: (patch: WorkshopNudgeViewPatch) => void;
  /** Narrow the next pass to one conference. Empty string means every open workshop. */
  onConferenceChange: (key: string) => void;
  onSend: () => void;
};

export function renderWorkshopNudges(props: WorkshopNudgesProps) {
  const result = props.state.result;
  const selectedCount = props.state.selectedRecipientIds.length;
  return html`
    <section class="adminbot-shell workshop-nudges" data-testid="adminbot-workshop-nudges">
      ${props.state.error
        ? html`<div
            class="card adminbot-card adminbot-card--wide adminbot-notice adminbot-notice--error workshop-nudges__error"
          >
            <span>${props.state.error}</span>
            <button
              class="btn"
              type="button"
              data-testid="workshop-nudges-refresh"
              @click=${props.onRefresh}
            >
              Try again
            </button>
          </div>`
        : nothing}
      ${renderRunProgress(props)}
      ${!result && props.state.loading && props.state.run?.status !== "running"
        ? html`<div class="card adminbot-card adminbot-card--wide muted">
            Finding workshop matches…
          </div>`
        : nothing}
      ${!result && !props.state.loading && !props.state.error
        ? html`<div class="card adminbot-card adminbot-card--wide workshop-nudges__empty">
            <strong>No recommendations yet</strong>
            <span class="muted">Find workshop matches for the current papers.</span>
            ${renderConferencePicker(props)}
            <button
              class="btn primary"
              type="button"
              data-testid="workshop-nudges-refresh"
              @click=${props.onRefresh}
            >
              Find recommendations
            </button>
          </div>`
        : nothing}
      ${renderSendResult(props)}
      ${result
        ? html`${renderResultActions(props, result)} ${renderSummary(result)}
          ${renderQueue(props, result, selectedCount)}`
        : nothing}
    </section>
  `;
}

/**
 * What a pass in flight looks like.
 *
 * The match is thousands of model calls and runs to completion on the server, so the page can be
 * opened, closed and reopened while it works. A bare spinner would say nothing about that -- and
 * after a minute or two it reads as broken rather than busy -- so this says how far along it is
 * and that leaving is safe.
 *
 * It also has to offer a way out. A pass whose count has stopped moving looks exactly like a slow
 * one from here, and for a long time this card was the whole page: no button, nothing to press,
 * nothing to do but reload and read the same number again. The server now writes a stalled pass
 * off on its own after half an hour, but an administrator who already knows should not have to
 * wait for it.
 */
function renderRunProgress(props: WorkshopNudgesProps) {
  const run = props.state.run;
  if (run?.status !== "running") {
    return nothing;
  }
  const done = run.calls_done ?? 0;
  const total = run.calls_total ?? 0;
  const failed = run.calls_failed ?? 0;
  return html`<div
    class="card adminbot-card adminbot-card--wide workshop-nudges__running"
    data-testid="workshop-nudges-running"
  >
    <strong>Matching in progress…</strong>
    <span class="muted">
      ${total > 0
        ? `${done} of ${total} model calls done.`
        : "Working out how many papers and workshops to compare."}
      ${failed > 0
        ? `${failed} call${failed === 1 ? "" : "s"} failed and will be missing from the result.`
        : ""}
      You can leave this page — the pass keeps running and the result is kept.
    </span>
    <div class="workshop-nudges__running-actions">
      <button
        class="btn"
        type="button"
        data-testid="workshop-nudges-cancel"
        ?disabled=${props.state.loading}
        @click=${props.onCancelRun}
      >
        Stop this pass
      </button>
      <button
        class="btn"
        type="button"
        data-testid="workshop-nudges-force-refresh"
        ?disabled=${props.state.loading}
        @click=${props.onForceRefresh}
      >
        Start over
      </button>
    </div>
  </div>`;
}

/**
 * Which conference the next pass covers.
 *
 * Rendered only when the service offered a list: an older one has no such route, and an empty
 * picker would read as "no conferences have workshops" rather than "this deployment cannot narrow".
 * The default is every open workshop, which is what the pass did before this existed.
 */
function renderConferencePicker(props: WorkshopNudgesProps) {
  const options = props.state.conferences;
  if (options.length === 0) {
    return nothing;
  }
  return html`<label class="workshop-nudges__conference">
    <span class="muted">Limit to</span>
    <select
      data-testid="workshop-nudges-conference"
      ?disabled=${props.state.loading || props.state.sending}
      .value=${props.state.conferenceKey}
      @change=${(event: Event) =>
        props.onConferenceChange((event.currentTarget as HTMLSelectElement).value)}
    >
      <option value="">Every open workshop</option>
      ${options.map(
        (option) => html`<option value=${option.key}>
          ${option.label} (${option.workshop_count})
        </option>`,
      )}
    </select>
  </label>`;
}

/**
 * What the last Send actually did.
 *
 * Every skip carries its own reason and they are shown, not counted: "member is not on the nudge
 * list" and "member has no slack_user_id" are different problems with different fixes, and a
 * summary line saying "12 skipped" sends somebody to the audit log to find out which.
 */
function renderSendResult(props: WorkshopNudgesProps) {
  const sent = props.state.sendResult;
  if (!sent) {
    return nothing;
  }
  const reasons = [...new Set(sent.skipped.map((entry) => entry.reason))];
  return html`<div
    class="workshop-nudges__send-result ${sent.skipped.length ? "is-warning" : "is-success"}"
    role="status"
    data-testid="workshop-nudges-send-result"
  >
    <strong>
      Sent ${sent.created} workshop nudge${sent.created === 1 ? "" : "s"}${sent.skipped.length
        ? `, skipped ${sent.skipped.length}`
        : ""}.
    </strong>
    ${reasons.length
      ? html`<ul class="workshop-nudges__send-reasons">
          ${reasons.map(
            (reason) => html`<li>
              ${reason}
              <span class="muted"
                >(${sent.skipped.filter((entry) => entry.reason === reason).length})</span
              >
            </li>`,
          )}
        </ul>`
      : nothing}
  </div>`;
}

function renderResultActions(props: WorkshopNudgesProps, result: WorkshopNudgeResult) {
  return html`<div class="workshop-nudges__result-actions">
    <span class="muted">
      Updated <time datetime=${result.generated_at}>${dateTimeLabel(result.generated_at)}</time>
      ${result.conference_label
        ? html`· limited to <strong>${result.conference_label}</strong>`
        : nothing}
    </span>
    ${renderConferencePicker(props)}
    <button
      class="btn"
      type="button"
      data-testid="workshop-nudges-refresh"
      ?disabled=${props.state.loading || props.state.sending}
      @click=${props.onRefresh}
    >
      ${props.state.loading ? "Refreshing…" : "Refresh"}
    </button>
  </div>`;
}

function renderSummary(result: WorkshopNudgeResult) {
  const ready = result.recipients.filter((recipient) => recipient.delivery_ready).length;
  return html`<div class="workshop-nudges__metrics">
    ${renderMetric(result.paper_count, "Papers")}
    ${renderMetric(result.recipients.length, "Recipients")} ${renderMetric(ready, "Ready to nudge")}
    ${renderMetric(result.unresolved_recipients.length, "Needs recipient link")}
  </div>`;
}

function renderMetric(value: number, label: string) {
  return html`<div class="card adminbot-card workshop-nudges__metric">
    <strong>${value}</strong><span>${label}</span>
  </div>`;
}

function renderQueue(
  props: WorkshopNudgesProps,
  result: WorkshopNudgeResult,
  selectedCount: number,
) {
  const tab = props.state.view.tab;
  return html`<section class="card adminbot-card adminbot-card--wide workshop-nudges__queue">
    <div class="workshop-nudges__tabs" role="tablist" aria-label="Workshop nudge review queues">
      ${queueTab(props, "recipients", `Recipients (${result.recipients.length})`)}
      ${queueTab(props, "unresolved", `Unresolved papers (${result.unresolved_recipients.length})`)}
    </div>
    <div class="workshop-nudges__filters">
      <input
        class="input"
        type="search"
        aria-label="Search workshop nudge queue"
        placeholder=${tab === "recipients"
          ? "Search people, papers, or workshops…"
          : "Search papers or workshops…"}
        .value=${props.state.view.query}
        @input=${(event: Event) =>
          props.onViewChange({
            query: (event.currentTarget as HTMLInputElement).value,
            page: 0,
            detailKey: null,
          })}
      />
      ${tab === "recipients"
        ? html`<select
            class="input"
            aria-label="Filter recipients by status"
            .value=${props.state.view.recipientFilter}
            @change=${(event: Event) =>
              props.onViewChange({
                recipientFilter: (event.currentTarget as HTMLSelectElement)
                  .value as WorkshopNudgeReviewState["view"]["recipientFilter"],
                page: 0,
                detailKey: null,
              })}
          >
            <option value="all">All statuses</option>
            <option value="ready">Ready to nudge</option>
            <option value="missing_slack">Missing Slack</option>
            <option value="no_match">No recommendation</option>
          </select>`
        : nothing}
    </div>
    ${tab === "recipients"
      ? renderRecipientQueue(props, result)
      : renderUnresolvedQueue(props, result)}
    <div class="workshop-nudges__selection-bar">
      <span>
        <strong>${selectedCount ? countLabel(selectedCount, "recipient") : "No recipients"}</strong>
        selected for a freshly recomputed message
      </span>
      <button
        class="btn primary"
        type="button"
        data-testid="workshop-nudges-send"
        ?disabled=${props.state.loading || props.state.sending || selectedCount === 0}
        @click=${props.onSend}
      >
        ${props.state.sending
          ? "Sending…"
          : selectedCount
            ? `Nudge ${countLabel(selectedCount, "recipient")}`
            : "Nudge"}
      </button>
    </div>
  </section>`;
}

function queueTab(
  props: WorkshopNudgesProps,
  tab: WorkshopNudgeReviewState["view"]["tab"],
  label: string,
) {
  const selected = props.state.view.tab === tab;
  return html`<button
    type="button"
    role="tab"
    aria-selected=${selected ? "true" : "false"}
    data-active=${selected ? "true" : "false"}
    @click=${() => props.onViewChange({ tab, page: 0, detailKey: null })}
  >
    ${label}
  </button>`;
}

function renderRecipientQueue(props: WorkshopNudgesProps, result: WorkshopNudgeResult) {
  const query = normalizedQuery(props.state.view.query);
  const filtered = result.recipients.filter(
    (recipient) =>
      recipientMatchesFilter(recipient, props.state.view.recipientFilter) &&
      searchableRecipient(recipient).includes(query),
  );
  const page = pageSlice(filtered, props.state.view.page);
  // Every ready recipient that matches the current filters, not just the page in view: with 40
  // recipients across three pages, a "select all" that only reached the visible ten meant three
  // rounds of select-and-flip-page, and unticking it silently left the other pages ticked.
  const readyIds = filtered
    .filter((recipient) => recipient.delivery_ready)
    .map((recipient) => recipient.recipient_member_id);
  const selected = new Set(props.state.selectedRecipientIds);
  const selectedReady = readyIds.filter((id) => selected.has(id)).length;
  const detail = detailRecipient(result, props.state.view.detailKey);
  return html`<div class="workshop-nudges__master-detail" data-detail=${detail ? "open" : "closed"}>
    <div>
      <div class="workshop-nudges__table-wrap">
        <table class="data-table workshop-nudges__table">
          <thead>
            <tr>
              <th class="data-table-checkbox-col">
                <input
                  type="checkbox"
                  aria-label="Select all ready recipients"
                  .checked=${readyIds.length > 0 && selectedReady === readyIds.length}
                  .indeterminate=${selectedReady > 0 && selectedReady < readyIds.length}
                  ?disabled=${readyIds.length === 0}
                  @change=${(event: Event) =>
                    props.onSetRecipients(
                      readyIds,
                      (event.currentTarget as HTMLInputElement).checked,
                    )}
                />
              </th>
              <th>Recipient</th>
              <th>Recommendations</th>
              <th>Next deadline</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${page.items.map((recipient) => recipientRow(props, recipient, selected))}
          </tbody>
        </table>
      </div>
      ${page.items.length
        ? pagination(props, page)
        : emptyQueue("No recipients match these filters.")}
    </div>
    ${detail
      ? renderRecipientDetail(props, detail, selected.has(detail.recipient_member_id))
      : nothing}
  </div>`;
}

function recipientRow(
  props: WorkshopNudgesProps,
  recipient: WorkshopNudgeRecipient,
  selected: Set<string>,
) {
  const workshops = new Set(
    recipient.recommendations.map((recommendation) => recommendation.workshop.workshop_id),
  ).size;
  return html`<tr>
    <td class="data-table-checkbox-col">
      <input
        type="checkbox"
        aria-label=${`Include ${recipient.recipient_display_name || recipient.recipient_member_id} in Nudge`}
        .checked=${selected.has(recipient.recipient_member_id)}
        ?disabled=${!recipient.delivery_ready}
        @change=${() => props.onToggleRecipient(recipient.recipient_member_id)}
      />
    </td>
    <td>
      <button
        class="workshop-nudges__row-link"
        type="button"
        @click=${() =>
          props.onViewChange({ detailKey: `recipient:${recipient.recipient_member_id}` })}
      >
        <strong>${recipient.recipient_display_name || recipient.recipient_member_id}</strong>
        <small>${recipient.recipient_member_id}</small>
      </button>
    </td>
    <td>
      <strong>${countLabel(recipient.recommendations.length, "pair")}</strong>
      <small>${countLabel(workshops, "workshop")}</small>
    </td>
    <td>${nextDeadlineLabel(recipient.recommendations)}</td>
    <td>${recipientStatusBadge(recipient)}</td>
  </tr>`;
}

function renderUnresolvedQueue(props: WorkshopNudgesProps, result: WorkshopNudgeResult) {
  const query = normalizedQuery(props.state.view.query);
  const filtered = result.unresolved_recipients.filter((entry) =>
    searchableUnresolved(entry).includes(query),
  );
  const page = pageSlice(filtered, props.state.view.page);
  const detail = detailUnresolved(result, props.state.view.detailKey);
  return html`${renderCoverage(result.coverage)}
    <div class="workshop-nudges__master-detail" data-detail=${detail ? "open" : "closed"}>
      <div>
        <div class="workshop-nudges__table-wrap">
          <table class="data-table workshop-nudges__table">
            <thead>
              <tr>
                <th>Paper</th>
                <th>Recommendations</th>
                <th>Next deadline</th>
              </tr>
            </thead>
            <tbody>
              ${page.items.map(
                (entry) => html`<tr>
                  <td>
                    <button
                      class="workshop-nudges__row-link"
                      type="button"
                      @click=${() =>
                        props.onViewChange({ detailKey: `unresolved:${entry.paper.paper_id}` })}
                    >
                      <strong>${entry.paper.title}</strong><small>No active linked recipient</small>
                    </button>
                  </td>
                  <td>${countLabel(entry.recommendations.length, "pair")}</td>
                  <td>${nextDeadlineLabel(entry.recommendations)}</td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>
        ${page.items.length
          ? pagination(props, page)
          : emptyQueue("No unresolved papers match this search.")}
      </div>
      ${detail ? renderUnresolvedDetail(props, detail) : nothing}
    </div>`;
}

function renderRecipientDetail(
  props: WorkshopNudgesProps,
  recipient: WorkshopNudgeRecipient,
  selected: boolean,
) {
  return detailPanel(
    props,
    recipient.recipient_display_name || recipient.recipient_member_id,
    recipientStatusBadge(recipient),
    html`<label class="workshop-nudges__retain">
        <input
          type="checkbox"
          .checked=${selected}
          ?disabled=${!recipient.delivery_ready}
          @change=${() => props.onToggleRecipient(recipient.recipient_member_id)}
        />
        ${recipient.delivery_ready
          ? "Include in Nudge"
          : recipient.delivery_blocked_reason || "Cannot send"}
      </label>
      ${recipient.draft
        ? html`<div class="workshop-nudges__preview">
            <strong>Exact Slack message</strong>
            <pre>${recipient.draft.text}</pre>
          </div>`
        : html`<p class="adminbot-form__notice">
            No workshop matched this recipient's papers, so AdminBot has nothing to send them.
          </p>`}
      <ol class="workshop-nudges__recommendations">
        ${recipient.recommendations.map((entry) => renderRecommendation(entry))}
      </ol>`,
  );
}

function renderUnresolvedDetail(props: WorkshopNudgesProps, entry: WorkshopNudgeUnresolved) {
  return detailPanel(
    props,
    entry.paper.title,
    html`<span class="chip">No active linked recipient</span>`,
    html`<ol class="workshop-nudges__recommendations">
      ${entry.recommendations.map((recommendation) =>
        renderRecommendation(recommendation, "Blocked until the paper recipient is linked"),
      )}
    </ol>`,
  );
}

function detailPanel(props: WorkshopNudgesProps, title: string, status: unknown, content: unknown) {
  return html`<aside class="workshop-nudges__detail" aria-label=${`Review ${title}`}>
    <div class="workshop-nudges__detail-head">
      <div>
        <div class="card-title">${title}</div>
        <div class="workshop-nudges__detail-status">${status}</div>
      </div>
      <button class="btn" type="button" @click=${() => props.onViewChange({ detailKey: null })}>
        Close
      </button>
    </div>
    ${content}
  </aside>`;
}

function normalizedQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function searchableRecipient(recipient: WorkshopNudgeRecipient): string {
  return normalizedQuery(
    [
      recipient.recipient_display_name,
      recipient.recipient_member_id,
      ...recipient.recommendations.flatMap((entry) => [entry.paper.title, entry.workshop.name]),
    ].join(" "),
  );
}

function searchableUnresolved(entry: WorkshopNudgeUnresolved): string {
  return normalizedQuery(
    [
      entry.paper.title,
      ...entry.recommendations.flatMap((recommendation) => [
        recommendation.workshop.name,
        ...recommendation.paper.publication_sources,
      ]),
    ].join(" "),
  );
}

function recipientFilterValue(
  recipient: WorkshopNudgeRecipient,
): WorkshopNudgeReviewState["view"]["recipientFilter"] {
  if (recipient.delivery_ready) {
    return "ready";
  }
  return recipient.delivery_blocked_reason?.toLocaleLowerCase().includes("slack")
    ? "missing_slack"
    : "no_match";
}

function recipientMatchesFilter(
  recipient: WorkshopNudgeRecipient,
  filter: WorkshopNudgeReviewState["view"]["recipientFilter"],
): boolean {
  return filter === "all" || recipientFilterValue(recipient) === filter;
}

function recipientStatusBadge(recipient: WorkshopNudgeRecipient) {
  const status = recipientFilterValue(recipient);
  if (status === "ready") {
    return html`<span class="chip" data-status="allowed">Ready</span>`;
  }
  if (status === "missing_slack") {
    return html`<span class="chip">Missing Slack</span>`;
  }
  return html`<span class="chip" data-status="unclear">No allowed match</span>`;
}

function nextDeadlineLabel(recommendations: WorkshopNudgeRecommendation[]): string {
  const deadline = recommendations
    .flatMap((entry) => entry.workshop.routes.map((route) => route.deadline_aoe))
    .toSorted()[0];
  return deadline ? aoeDateTimeLabel(deadline) : "Not recorded";
}

type WorkshopNudgePage<T> = {
  items: T[];
  index: number;
  count: number;
  total: number;
};

function pageSlice<T>(entries: T[], requestedPage: number): WorkshopNudgePage<T> {
  const count = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const index = Math.min(Math.max(0, requestedPage), count - 1);
  return {
    items: entries.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE),
    index,
    count,
    total: entries.length,
  };
}

function pagination<T>(props: WorkshopNudgesProps, page: WorkshopNudgePage<T>) {
  return html`<div class="workshop-nudges__pagination">
    <span class="muted">${page.total} results · Page ${page.index + 1} of ${page.count}</span>
    <div>
      <button
        class="btn"
        type="button"
        ?disabled=${page.index === 0}
        @click=${() => props.onViewChange({ page: page.index - 1, detailKey: null })}
      >
        Previous
      </button>
      <button
        class="btn"
        type="button"
        ?disabled=${page.index >= page.count - 1}
        @click=${() => props.onViewChange({ page: page.index + 1, detailKey: null })}
      >
        Next
      </button>
    </div>
  </div>`;
}

function emptyQueue(message: string) {
  return html`<div class="workshop-nudges__empty">
    <strong>No results</strong><span class="muted">${message}</span>
  </div>`;
}

function detailRecipient(
  result: WorkshopNudgeResult,
  key: string | null,
): WorkshopNudgeRecipient | undefined {
  if (!key?.startsWith("recipient:")) {
    return undefined;
  }
  const id = key.slice("recipient:".length);
  return result.recipients.find((entry) => entry.recipient_member_id === id);
}

function detailUnresolved(
  result: WorkshopNudgeResult,
  key: string | null,
): WorkshopNudgeUnresolved | undefined {
  if (!key?.startsWith("unresolved:")) {
    return undefined;
  }
  const id = key.slice("unresolved:".length);
  return result.unresolved_recipients.find((entry) => entry.paper.paper_id === id);
}

function renderRecommendation(recommendation: WorkshopNudgeRecommendation, blockedLabel?: string) {
  const route = recommendation.workshop.routes[0];
  const status = recommendation.workshop.cross_submission_status;
  return html`
    <li class="workshop-nudges__recommendation" data-status=${status}>
      <div class="workshop-nudges__rank">#${recommendation.final_rank ?? "–"}</div>
      <div class="workshop-nudges__recommendation-body">
        <div class="workshop-nudges__pair">
          <strong>${recommendation.paper.title}</strong><span aria-hidden="true">→</span
          ><strong>${recommendation.workshop.name}</strong>
        </div>
        <div class="workshop-nudges__chips">
          <span class="chip">${Math.round(recommendation.topic_relevance * 100)}% call fit</span>
          <span class="chip" data-status=${status}>${displayLabel(status)}</span>
          ${recommendation.paper.current_submission_state
            ? html`<span class="chip"
                >${displayLabel(recommendation.paper.current_submission_state)}</span
              >`
            : nothing}
        </div>
        <p>${recommendation.rank_explanation}</p>
        <dl class="workshop-nudges__evidence">
          <div>
            <dt>Topic evidence</dt>
            <dd>${recommendation.topic_evidence.map(cleanEvidenceLabel).join(", ")}</dd>
          </div>
          <div>
            <dt>Publication</dt>
            <dd>
              <strong>${archivalLabel(recommendation.workshop.archival_status)}</strong>
              ${archivalDescription(recommendation.workshop.archival_status)}
            </dd>
          </div>
          <div>
            <dt>Cross-submission</dt>
            <dd>
              <strong>${crossSubmissionLabel(status)}</strong>
              ${crossSubmissionDescription(status)}
              ${recommendation.workshop.cross_submission_source_url
                ? html` ·
                    <a
                      href=${recommendation.workshop.cross_submission_source_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      >Source</a
                    >`
                : nothing}
              <details>
                <summary>Source evidence</summary>
                <p>${recommendation.workshop.cross_submission_evidence}</p>
              </details>
            </dd>
          </div>
          <div>
            <dt>Submission route</dt>
            <dd>
              ${displayLabel(route?.label ?? "Submission")} ·
              ${displayLabel(route?.submission_type ?? "unspecified")} ·
              ${route ? aoeDateTimeLabel(route.deadline_aoe) : "Not recorded"}
              ${route?.source_url
                ? html` ·
                    <a href=${route.source_url} target="_blank" rel="noreferrer noopener"
                      >Source</a
                    >`
                : nothing}
            </dd>
          </div>
          <div>
            <dt>Profile checked</dt>
            <dd>${dateLabel(recommendation.workshop.profile_extracted_at)}</dd>
          </div>
          <div>
            <dt>Parent conference</dt>
            <dd>
              ${recommendation.workshop.parent_conference} ·
              ${recommendation.workshop.conference_location}
            </dd>
          </div>
          <div>
            <dt>Attendance</dt>
            <dd>
              ${recommendation.attendance?.attendance_likelihood === undefined
                ? "Unknown; not used in ranking."
                : `${recommendation.attendance.attendance_likelihood}% · ${recommendation.attendance.source} · Confirmed ${dateLabel(recommendation.attendance.last_confirmed_at)}`}
            </dd>
          </div>
          <div>
            <dt>Paper status</dt>
            <dd>
              ${displayLabel(recommendation.paper.current_submission_state || "Not recorded")} ·
              Source: ${recommendation.paper.publication_sources.join(", ") || "Not recorded"}
            </dd>
          </div>
        </dl>
        <div class="workshop-nudges__include">
          ${blockedLabel ? blockedLabel : "Included in the server-generated message"}
        </div>
      </div>
    </li>
  `;
}

function renderCoverage(coverage: NonNullable<WorkshopNudgeReviewState["result"]>["coverage"]) {
  const count =
    coverage.members_without_usable_papers.length +
    coverage.papers_with_unresolved_authors.length +
    coverage.papers_without_active_recipients.length;
  if (!count) {
    return nothing;
  }
  return html`<section class="workshop-nudges__coverage">
    <div class="card-title">Paper coverage</div>
    <div class="card-sub">
      Missing paper or member links are reported, not interpreted as evidence that a member has no
      relevant papers.
    </div>
    ${coverage.members_without_usable_papers.length
      ? html`<details>
          <summary>
            ${countLabel(coverage.members_without_usable_papers.length, "member")} without a usable
            paper record
          </summary>
          <ul>
            ${coverage.members_without_usable_papers.map(
              (member) =>
                html`<li>${member.name} <span class="muted">${member.member_id}</span></li>`,
            )}
          </ul>
        </details>`
      : nothing}
    ${coverage.papers_with_unresolved_authors.length
      ? html`<details>
          <summary>
            ${countLabel(coverage.papers_with_unresolved_authors.length, "paper")} with unresolved
            authors
          </summary>
          <ul>
            ${coverage.papers_with_unresolved_authors.map(
              (paper) => html`<li>${paper.title}: ${paper.author_names.join(", ")}</li>`,
            )}
          </ul>
        </details>`
      : nothing}
    ${coverage.papers_without_active_recipients.length
      ? html`<details>
          <summary>
            ${countLabel(coverage.papers_without_active_recipients.length, "paper")} without an
            active linked recipient
          </summary>
          <ul>
            ${coverage.papers_without_active_recipients.map(
              (paper) => html`<li>${paper.title} <span class="muted">${paper.paper_id}</span></li>`,
            )}
          </ul>
        </details>`
      : nothing}
  </section>`;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function archivalLabel(status: WorkshopNudgeRecommendation["workshop"]["archival_status"]): string {
  if (status === "non_archival") {
    return "Non-archival";
  }
  if (status === "archival") {
    return "Archival";
  }
  if (status === "mixed") {
    return "Mixed publication status";
  }
  return "Publication status unknown";
}

function archivalDescription(
  status: WorkshopNudgeRecommendation["workshop"]["archival_status"],
): string {
  if (status === "non_archival") {
    return "Does not count as publishing; you can still submit the paper elsewhere.";
  }
  if (status === "archival") {
    return "Counts as publishing in formal proceedings.";
  }
  if (status === "mixed") {
    return "Offers both archival and non-archival submission options.";
  }
  return "The collected call does not establish whether accepted papers are published.";
}

function crossSubmissionLabel(
  status: WorkshopNudgeRecommendation["workshop"]["cross_submission_status"],
): string {
  return status === "allowed"
    ? "Allowed"
    : status === "prohibited"
      ? "Prohibited"
      : "Not confirmed";
}

function crossSubmissionDescription(
  status: WorkshopNudgeRecommendation["workshop"]["cross_submission_status"],
): string {
  if (status === "allowed") {
    return "The CFP explicitly permits submission elsewhere.";
  }
  if (status === "prohibited") {
    return "The CFP explicitly prohibits submission elsewhere during review; check before submitting.";
  }
  return "No explicit rule was found; check the call before submitting.";
}

function displayLabel(value: string): string {
  const label = value.replaceAll("_", " ").trim();
  return label ? `${label[0]?.toLocaleUpperCase()}${label.slice(1)}` : value;
}

function cleanEvidenceLabel(value: string): string {
  let label = value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[,;:.\s]+|[,;:.\s]+$/gu, "");
  if ((label.match(/\(/gu)?.length ?? 0) !== (label.match(/\)/gu)?.length ?? 0)) {
    label = label.replace(/[()]/gu, "").replace(/\s+/gu, " ").trim();
  }
  return label;
}

function dateLabel(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? value
    : formatDateMs(timestamp, { dateStyle: "medium", timeZone: "UTC" }, value);
}

function dateTimeLabel(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? value
    : formatDateTimeMs(timestamp, { dateStyle: "medium", timeStyle: "short" }, value);
}
