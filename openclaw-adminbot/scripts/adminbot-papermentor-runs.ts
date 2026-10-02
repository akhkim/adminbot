#!/usr/bin/env node
// Reports PaperMentor's reviews to AdminBot: what it reviewed, when, and how much it found.
//
// PaperMentor is the reviewer built into the lab's Overleaf, and it caches each run it finishes at
// <cache dir>/<project id>/review_comments.json. That file is the only durable record of a review
// -- the comments themselves go into the author's project as threads, and the next review of the
// same project overwrites the file -- so this pass reads it while it is there and posts the
// counting half to AdminBot, which keeps the history.
//
// What crosses the boundary is decided by `summarizePaperMentorReview`, not by this file: it
// copies a fixed set of counts and can carry no comment text, because it never reads any. The
// paper itself stays on the machine that holds it.
//
// Idempotent by construction. Every run is identified by its project and the instant it ran, so
// re-reading the same cached review posts the same id and the service records nothing new. There
// is no local cursor to keep in step with anything.
//
// Runs wherever the cache directory is readable -- the Overleaf host itself, or the AdminBot host
// with the directory mounted or synced -- and posts to ADMINBOT_URL (the loopback service by
// default). See docs/tools/adminbot.md, "PaperMentor reviews".

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  summarizePaperMentorReview,
  type AdminBotPaperMentorRunInput,
} from "../extensions/adminbot/src/contracts/papermentor.js";
import { isMainModule } from "./lib/is-main-module.mjs";

export const DEFAULT_PAPERMENTOR_CACHE_DIR = "/var/lib/overleaf/ai-tutor-cache";
const REVIEW_FILE = "review_comments.json";

/** What became of one cached review. Every pass reports these counts and nothing else. */
export type PaperMentorRunOutcome =
  /** New to AdminBot, and now on the paper. */
  | "recorded"
  /** Already on file: the ordinary answer between reviews, not a problem. */
  | "known"
  /** Reviewed, but no paper carries that Overleaf project. Somebody should register the paper. */
  | "unmatched"
  /** A cache directory whose review file is missing, half-written, or a shape we do not know. */
  | "unreadable"
  /** The service could not be reached, or refused for a reason that is not about this review. */
  | "failed";

export type PaperMentorCollectSummary = Record<PaperMentorRunOutcome, number>;

export type PaperMentorPoster = (
  run: AdminBotPaperMentorRunInput,
) => Promise<{ outcome: PaperMentorRunOutcome; note?: string }>;

/**
 * Read every cached review under `cacheDir` and hand each to `post`.
 *
 * The walk is deliberately forgiving: one project whose file is half-written must not stop the
 * forty that are fine, so an unreadable directory is counted and named rather than thrown on.
 */
export async function collectPaperMentorRuns(options: {
  cacheDir: string;
  post: PaperMentorPoster;
  /** Reviews older than this are left alone, so a first run does not report a year as news. */
  since?: Date;
  log?: (line: string) => void;
}): Promise<PaperMentorCollectSummary> {
  const log = options.log ?? ((line: string) => console.log(line));
  const summary: PaperMentorCollectSummary = {
    recorded: 0,
    known: 0,
    unmatched: 0,
    unreadable: 0,
    failed: 0,
  };
  const floor = options.since?.getTime();
  for (const projectDir of await readProjectDirs(options.cacheDir)) {
    const file = path.join(options.cacheDir, projectDir, REVIEW_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      // No review for this project yet. Most directories are this: the cache holds merged sources
      // for anything the panel has opened, reviewed or not.
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      summary.unreadable += 1;
      log(`  unreadable ${projectDir}: not JSON`);
      continue;
    }
    const run = summarizePaperMentorReview(parsed);
    if (!run) {
      summary.unreadable += 1;
      log(`  unreadable ${projectDir}: not a finished review`);
      continue;
    }
    if (floor !== undefined && Date.parse(run.reviewed_at) < floor) {
      continue;
    }
    const result = await options.post(run);
    summary[result.outcome] += 1;
    if (result.note) {
      log(`  ${result.note}`);
    }
  }
  return summary;
}

async function readProjectDirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

/** Posts one review to the service, mapping its answer onto an outcome. */
export function createPaperMentorPoster(options: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): PaperMentorPoster {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return async (run) => {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetchImpl(`${baseUrl}/papers/papermentor/runs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(run),
      });
    } catch (error) {
      return { outcome: "failed", note: `failed ${run.project_id}: ${(error as Error).message}` };
    }
    const body = (await response.json().catch(() => ({}))) as {
      paper_id?: string;
      recorded?: boolean;
      error?: { message?: string };
    };
    // A review of a project no paper claims. Named rather than silent: it is usually a paper
    // nobody registered with AdminBot, which is the thing for somebody to go and fix.
    if (response.status === 404) {
      return { outcome: "unmatched", note: `no paper for project ${run.project_id}` };
    }
    if (!response.ok) {
      return {
        outcome: "failed",
        note: `failed ${run.project_id}: HTTP ${response.status} ${body.error?.message ?? ""}`.trim(),
      };
    }
    return body.recorded
      ? {
          outcome: "recorded",
          note: `recorded ${run.project_id} -> ${body.paper_id} (${run.comments_total} comments)`,
        }
      : { outcome: "known" };
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "cache-dir": { type: "string" },
      "dry-run": { type: "boolean" },
      since: { type: "string" },
    },
    strict: true,
  });
  const cacheDir =
    values["cache-dir"]?.trim() ||
    process.env.ADMINBOT_PAPERMENTOR_CACHE_DIR?.trim() ||
    DEFAULT_PAPERMENTOR_CACHE_DIR;
  const dryRun = Boolean(values["dry-run"]);
  const since = values.since ? new Date(values.since) : undefined;
  if (since && !Number.isFinite(since.getTime())) {
    throw new Error(`--since ${values.since} is not a date`);
  }
  const token = process.env.ADMINBOT_SERVICE_TOKEN?.trim();
  if (!dryRun && !token) {
    throw new Error("ADMINBOT_SERVICE_TOKEN is not set");
  }
  const baseUrl =
    process.env.ADMINBOT_URL?.trim() || `http://127.0.0.1:${process.env.ADMINBOT_PORT ?? "8765"}`;
  // A dry run reads and summarizes exactly as a live one does and stops short of the post, so what
  // it prints is what would be sent -- including which reviews are old enough to be skipped.
  const post: PaperMentorPoster = dryRun
    ? async (run) => ({
        outcome: "recorded",
        note: `would post ${run.project_id} reviewed ${run.reviewed_at}: ${run.comments_total} comment(s)`,
      })
    : createPaperMentorPoster({ baseUrl, token: token ?? "" });

  const summary = await collectPaperMentorRuns({
    cacheDir,
    post,
    ...(since ? { since } : {}),
  });
  console.log(
    `papermentor runs: ${summary.recorded} ${dryRun ? "to post" : "new"}, ` +
      `${summary.known} already on file, ${summary.unmatched} with no paper, ` +
      `${summary.unreadable} unreadable, ${summary.failed} failed`,
  );
  // A pass that could not reach the service is a failure; one that found a review for a paper
  // nobody registered is not -- that is an ordinary state of the world, and the count says so.
  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`papermentor runs: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
