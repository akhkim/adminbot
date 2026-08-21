// The "on demand" half of the Cron tab: jobs that exist to be pressed, not scheduled.
//
// It lives beside the scheduled-jobs list rather than on a tab of its own because both answer the
// same question — "what background work does this lab run, and when did it last run?" — and an
// operator looking for the CV digest should not have to know whether it happens to be on a timer.
//
// Its own file because ui/src/ui/views/cron.ts is already close to the 2,200-line `max-lines`
// threshold that ADR-0006 grandfathers the existing offenders against; a new section belongs
// outside it rather than pushing it over.
//
// Strings here are literal English rather than `t(...)` keys. Every AdminBot surface in this repo
// is written that way, and the shipped locale bundles already sit 442 keys behind English
// (docs/refactor-baseline.md) — adding keys only English defines would widen that gap.

import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";

export type CronCommandJobStatus = "idle" | "running" | "ok" | "error";

export type CronCommandJob = {
  id: string;
  name: string;
  description: string;
  status: CronCommandJobStatus;
  // What the last press produced, in one line — "wrote 12 updates across 4 days", or the reason it
  // failed. Absent until the job has been run in this session.
  detail?: string;
  // Where the job's output landed, when it lands somewhere a person can open.
  resultUrl?: string;
  resultLabel?: string;
  finishedAtMs?: number;
  // Why the button is disabled, or absent when it is not. A reason rather than a boolean so the
  // UI can say what is missing instead of showing a dead control.
  disabledReason?: string;
};

export function renderCronCommandJobs(params: {
  jobs: CronCommandJob[];
  onRun: (id: string) => void;
}) {
  if (!params.jobs.length) {
    return nothing;
  }
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 12px;">
        <div>
          <div class="card-title">On demand</div>
          <div class="card-sub">
            Jobs that run when you press them rather than on a schedule. Each one runs on the
            AdminBot service, so closing this page does not stop it.
          </div>
        </div>
      </div>
      <div class="cron-command-jobs">
        ${params.jobs.map((job) => renderCommandJob(job, params.onRun))}
      </div>
    </section>
  `;
}

function renderCommandJob(job: CronCommandJob, onRun: (id: string) => void) {
  const running = job.status === "running";
  return html`
    <div class="cron-command-job" data-test-id=${`cron-command-job-${job.id}`}>
      <div class="cron-command-job__text">
        <div class="cron-command-job__name">${job.name}</div>
        <div class="cron-command-job__desc muted">${job.description}</div>
        ${renderOutcome(job)}
      </div>
      <div class="cron-command-job__actions">
        <button
          class="btn btn--primary"
          type="button"
          ?disabled=${running || Boolean(job.disabledReason)}
          title=${job.disabledReason ?? ""}
          @click=${() => onRun(job.id)}
        >
          ${running ? "Running…" : "Run"}
        </button>
      </div>
    </div>
  `;
}

function renderOutcome(job: CronCommandJob) {
  if (job.disabledReason) {
    return html`<div class="cron-command-job__outcome muted">${job.disabledReason}</div>`;
  }
  if (job.status === "running") {
    return html`<div class="cron-command-job__outcome muted">
      Running — this can take a few minutes.
    </div>`;
  }
  if (job.status === "idle" || !job.detail) {
    return nothing;
  }
  const when =
    job.finishedAtMs === undefined
      ? nothing
      : html` <span class="muted">· ${formatRelativeTimestamp(job.finishedAtMs)}</span>`;
  return html`
    <div
      class=${`cron-command-job__outcome ${job.status === "error" ? "cron-command-job__outcome--error" : ""}`}
    >
      <span class=${job.status === "error" ? "chip chip-danger" : "chip chip-ok"}>
        ${job.status === "error" ? "Failed" : "Done"}
      </span>
      <span>${job.detail}</span>${when}
      ${job.resultUrl
        ? html` <a href=${job.resultUrl} target="_blank" rel="noreferrer noopener"
            >${job.resultLabel ?? "Open"}</a
          >`
        : nothing}
    </div>
  `;
}
