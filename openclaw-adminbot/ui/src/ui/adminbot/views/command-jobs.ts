// The Cron tab's on-demand AdminBot jobs (see views/cron-command-jobs.ts for how they render).
//
// Cut from app-render.ts, which is grandfathered under the file-size ratchet, so the list can grow
// here without pushing it over.
import type { AppViewState } from "../../app-view-state.ts";
import type { CronCommandJob } from "../../views/cron-command-jobs.ts";
import { runAdminBotVenueIndexJob } from "../controllers/conference-papers.ts";
import { runAdminBotChannelNamingJob, runAdminBotCvDigestJob } from "../controllers/directory.ts";
import { runAdminBotCvScan } from "../controllers/task-jobs.ts";

export function adminBotCommandJobs(state: AppViewState): CronCommandJob[] {
  return [
    {
      id: "venue-index",
      name: "Conference paper index",
      description:
        "Rebuild the conference paper index from scratch. It already refreshes itself overnight whenever a conference's accepted list changes, so press this only to force a rebuild that nothing changed. Takes a couple of minutes per conference.",
      status: state.adminBotVenueIndexJob.status,
      ...(state.adminBotVenueIndexJob.detail ? { detail: state.adminBotVenueIndexJob.detail } : {}),
      ...(state.adminBotVenueIndexJob.finishedAtMs
        ? {
            finishedAtMs: state.adminBotVenueIndexJob.finishedAtMs,
          }
        : {}),
    },
    {
      id: "cv-scan",
      name: "Scan CVs",
      description:
        "Read linked CVs and record changes. Review the result before publishing the digest.",
      ...state.adminBotCvScanJob,
    },
    {
      id: "cv-digest",
      name: "CV digest",
      description:
        "Re-read every member's linked CV, record what changed, and rewrite the CV Updates doc with today's date.",
      status: state.adminBotCvDigestJob.status,
      ...(state.adminBotCvDigestJob.detail ? { detail: state.adminBotCvDigestJob.detail } : {}),
      ...(state.adminBotCvDigestJob.resultUrl
        ? {
            resultUrl: state.adminBotCvDigestJob.resultUrl,
            resultLabel: "Open the doc",
          }
        : {}),
      ...(state.adminBotCvDigestJob.finishedAtMs
        ? {
            finishedAtMs: state.adminBotCvDigestJob.finishedAtMs,
          }
        : {}),
    },
    {
      id: "channel-naming",
      name: "Slack channel naming",
      description:
        "Find channels still breaking the naming policy 48 hours after their owner was reminded, and propose a rename for each. Renames nothing on its own — the proposals wait for you in Pending Actions.",
      status: state.adminBotChannelNamingJob.status,
      ...(state.adminBotChannelNamingJob.detail
        ? { detail: state.adminBotChannelNamingJob.detail }
        : {}),
      ...(state.adminBotChannelNamingJob.finishedAtMs
        ? {
            finishedAtMs: state.adminBotChannelNamingJob.finishedAtMs,
          }
        : {}),
    },
  ];
}

export function runAdminBotCommandJob(state: AppViewState, id: string): void {
  if (id === "cv-scan") {
    void runAdminBotCvScan(state);
  }
  if (id === "cv-digest") {
    void runAdminBotCvDigestJob(state);
  }
  if (id === "venue-index") {
    void runAdminBotVenueIndexJob(state);
  }
  if (id === "channel-naming") {
    void runAdminBotChannelNamingJob(state);
  }
}
