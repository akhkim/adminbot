// Runs PaperMentor on this host for the PaperMentor tab: a member uploads an Overleaf source zip,
// papermentor-pdf (github.com/akhkim/papermentor-pdf) reviews it, compiles it and writes every
// comment onto the PDF and into the .tex files, and the member downloads the post-review zip.
//
// This is not the paper-stage review (connectors/papermentor-review.ts), which asks the lab's
// Overleaf to review a paper it already hosts. Nothing here touches Overleaf, a paper record or a
// paper slot: an upload is reviewed, handed back, and deleted after a retention window.
//
// What leaves the process:
// - the draft's text, to the model provider papermentor-pdf is configured for -- the lab's LLM
//   gateway when LLM_GATEWAY_URL/LLM_GATEWAY_TOKEN are set (docs/tools/llm-gateway.md), otherwise
//   OpenRouter or OpenAI directly. That is what a PaperMentor review is, and the member agrees to it
//   on every upload (the route refuses one without that consent).
// - counts, to the caller (the job record): comment totals by severity. Never a comment, never the
//   child's own output, which can quote the paper.
//
// What stays on this disk, under the work root, one folder per review (mode 0700): the files the
// member downloads, and the child's stderr in run.log for an admin to debug a failed run. The
// extracted source is removed as soon as the review ends. The whole folder goes after
// `retentionDays`.
//
// The LaTeX build is the dangerous part of reviewing somebody else's zip: latexmk reads a
// `latexmkrc` from the project, which is Perl, so an uploaded zip could run code on this host. Only
// Tectonic (no rc files, no shell escape) or no build at all is ever used here, whatever the
// papermentor-pdf default would pick.
//
// The reference check is the PDF Reference Checker folded into the review: with the member's
// consent, every reference the paper cites is looked up in the scholarly databases. It reads the
// cited entries straight out of the zip -- the .bib's own fields, or a hand-written \bibitem list
// (bib-references.ts) -- and never the built PDF: splitting a bibliography out of PDF text is the
// step the PDF checker most often fails at, and the source has every entry separated already. A zip
// with neither is reported as not checked. The lookup itself, and its approval gate, are injected
// (`checkReferences`): this file never decides whether something may leave the host, only what
// would be sent.
//
// One review at a time. A review is a few minutes of model calls plus a LaTeX build, and running
// two at once buys nothing but contention on the CPU the service also needs.
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { citedBibReferences } from "./bib-references.js";
import {
  ReferenceCheckError,
  type ReferenceEntry,
  type ReferenceFinding,
} from "./reference-check.js";

/** Where papermentor-pdf is installed on this host. Unset, the PaperMentor tab says it is off. */
export const ADMINBOT_PAPERMENTOR_PDF_DIR_ENV = "ADMINBOT_PAPERMENTOR_PDF_DIR";

export type PaperMentorUploadStatus = "queued" | "running" | "reviewed" | "rejected" | "failed";

/**
 * The files a finished review leaves, by what they are. `commented_zip` is the post-review zip --
 * the paper with a `%PAPERMENTOR:` line above each passage a comment is about -- and comes first
 * because it is what the tab is for.
 */
export const paperMentorUploadFileKinds = [
  "commented_zip",
  "reviewed_pdf",
  "report",
  "edits_diff",
  "references",
] as const;
export type PaperMentorUploadFileKind = (typeof paperMentorUploadFileKinds)[number];

const FILE_NAMES: Record<
  PaperMentorUploadFileKind,
  { name: string; suffix: string; media_type: string }
> = {
  commented_zip: {
    name: "commented.zip",
    suffix: "papermentor.zip",
    media_type: "application/zip",
  },
  reviewed_pdf: { name: "reviewed.pdf", suffix: "reviewed.pdf", media_type: "application/pdf" },
  report: { name: "review.md", suffix: "review.md", media_type: "text/markdown; charset=utf-8" },
  edits_diff: {
    name: "edits.diff",
    suffix: "edits.diff",
    media_type: "text/x-diff; charset=utf-8",
  },
  references: {
    name: "references.json",
    suffix: "references.json",
    media_type: "application/json; charset=utf-8",
  },
};

/** The reference check's outcome on the record: counts only, the findings are in the file. */
export type PaperMentorReferenceSummary = {
  status: "checked" | "failed" | "skipped";
  /**
   * Where the references were read from: always the paper's source now. "pdf" survives only on a
   * review made before the PDF fallback was dropped (kept for `retentionDays`).
   */
  source?: "bib" | "pdf";
  total?: number;
  matched?: number;
  needs_review?: number;
  not_found?: number;
  unavailable?: number;
  /** Cited keys with no usable bibliography entry, so not looked up. */
  skipped_entries?: number;
  message?: string;
};

/** Looks the references up, behind the approval gate. Built by the service (api/server.ts). */
export type PaperMentorReferenceCheck = (input: {
  memberId: string;
  /** The paper's own entries, from its .bib or \bibitem list (bib-references.ts). */
  references: ReferenceEntry[];
  signal: AbortSignal;
}) => Promise<{ findings: ReferenceFinding[] }>;

/** One review, as the tab lists it. Counts and states only: never a comment. */
export type PaperMentorUpload = {
  id: string;
  /** The member who uploaded it. Only they see it (the route's rule). */
  requested_by: string;
  /** The uploaded file's name, without `.zip`: what the member will recognize. */
  label: string;
  venue: string;
  status: PaperMentorUploadStatus;
  /** While running: which half of the job it is in. */
  phase?: "review" | "references";
  /** Whether the member asked for (and agreed to) the reference check. */
  check_references?: boolean;
  references?: PaperMentorReferenceSummary;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  /** Why it did not finish, in words chosen here -- never a child process's own output. */
  message?: string;
  comments?: number;
  by_severity?: Record<string, number>;
  /** Whether the PDF was built, or the comments are in the report and the .tex files alone. */
  pdf?: boolean;
  files: PaperMentorUploadFileKind[];
};

export type PaperMentorUploadSubmission = {
  requested_by: string;
  label: string;
  venue?: string;
  zip: Buffer;
  /** Also check the references. Only set once the member has agreed to the database lookups. */
  check_references?: boolean;
  onFinished?: (upload: PaperMentorUpload) => void | Promise<void>;
};

export type PaperMentorUploadSubmitResult =
  | { ok: true; upload: PaperMentorUpload }
  | { ok: false; status: 400 | 413 | 429; message: string };

export type PaperMentorUploadReviewer = {
  submit(input: PaperMentorUploadSubmission): PaperMentorUploadSubmitResult;
  /** One member's reviews, newest first. */
  uploadsFor(memberId: string): PaperMentorUpload[];
  upload(id: string): PaperMentorUpload | undefined;
  file(
    id: string,
    kind: PaperMentorUploadFileKind,
  ): { filename: string; media_type: string; path: string } | undefined;
  /** Venue keys papermentor-pdf has guidelines for, `arxiv` first. */
  venues(): string[];
  /** Where the draft's text goes, for the consent line in the tab. */
  modelProvider: string;
  maxZipBytes: number;
  /** Whether this host can check references as part of a review. */
  checksReferences: boolean;
  /** Resolves once nothing is queued or running. For tests and for a clean shutdown. */
  idle(): Promise<void>;
};

/** Caps that keep one busy week, or one member, from becoming a backlog or a bill. */
export const PAPERMENTOR_UPLOAD_LIMITS = {
  /** Queued plus running, across everybody. */
  queue: 10,
  /** Reviews one member may ask for in a day. Each is a paid run of a dozen model calls. */
  perMemberPerDay: 5,
  maxZipBytes: 40 * 1024 * 1024,
  /** Review and build together. Generous: a cold Tectonic package cache is slow. */
  timeoutMs: 45 * 60_000,
  /** How long a review's files stay downloadable before the folder is deleted. */
  retentionDays: 14,
  /** The reference lookups, on top of the review. Rate-limited databases make this the slow part. */
  referenceTimeoutMs: 30 * 60_000,
};

export type PaperMentorSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; logFile: string },
) => Promise<{ code: number | null; stdout: string }>;

const JOB_ID = /^pm_[0-9a-f]{16}$/u;
const DAY_MS = 86_400_000;
/** The only builds an uploaded zip may get (see the header): never latexmk. */
type BuildEngine = "tectonic" | "none";

export function createPaperMentorUploadReviewer(options: {
  /** The papermentor-pdf install (holds bin/papermentor.mjs). */
  pdfDir: string;
  /** Where review folders live. On Aurora, under the release's `state/` symlink. */
  workRoot: string;
  /** The child environment's source; only an allow-list of it is passed on. */
  env?: NodeJS.ProcessEnv;
  node?: string;
  spawn?: PaperMentorSpawn;
  now?: () => Date;
  limits?: Partial<typeof PAPERMENTOR_UPLOAD_LIMITS>;
  checkReferences?: PaperMentorReferenceCheck;
}): PaperMentorUploadReviewer {
  const env = options.env ?? process.env;
  const node = options.node ?? process.execPath;
  const spawn = options.spawn ?? spawnLogged;
  const now = options.now ?? (() => new Date());
  const limits = { ...PAPERMENTOR_UPLOAD_LIMITS, ...options.limits };
  const engine: BuildEngine =
    env.ADMINBOT_PAPERMENTOR_ENGINE?.trim() === "none" ? "none" : "tectonic";
  const model = env.ADMINBOT_PAPERMENTOR_MODEL?.trim();
  const jobsDir = path.join(options.workRoot, "uploads");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  const queue: Array<{ upload: PaperMentorUpload; input: PaperMentorUploadSubmission }> = [];
  let running: PaperMentorUpload | undefined;
  let idleWaiters: Array<() => void> = [];

  const jobDir = (id: string) => path.join(jobsDir, id);
  const workDir = (id: string) => path.join(jobDir(id), "work");
  const save = (upload: PaperMentorUpload) => {
    fs.mkdirSync(jobDir(upload.id), { recursive: true, mode: 0o700 });
    const file = path.join(jobDir(upload.id), "job.json");
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(upload, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const load = (id: string): PaperMentorUpload | undefined => {
    if (!JOB_ID.test(id)) {
      return undefined;
    }
    try {
      return JSON.parse(
        fs.readFileSync(path.join(jobDir(id), "job.json"), "utf8"),
      ) as PaperMentorUpload;
    } catch {
      return undefined;
    }
  };
  const all = (): PaperMentorUpload[] =>
    fs
      .readdirSync(jobsDir)
      .flatMap((id) => {
        const upload = load(id);
        return upload ? [upload] : [];
      })
      .toSorted((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  const active = () => [...(running ? [running] : []), ...queue.map((entry) => entry.upload)];

  /** Deletes reviews past retention. Never one that is queued or running. */
  const prune = () => {
    const cutoff = now().getTime() - limits.retentionDays * DAY_MS;
    const busy = new Set(active().map((upload) => upload.id));
    for (const id of fs.readdirSync(jobsDir)) {
      if (!JOB_ID.test(id) || busy.has(id)) {
        continue;
      }
      const upload = load(id);
      const created = upload ? Date.parse(upload.created_at) : Number.NaN;
      // A folder with no readable record is a half-written one; it holds nothing to hand out.
      if (!upload || !Number.isFinite(created) || created < cutoff) {
        fs.rmSync(jobDir(id), { recursive: true, force: true });
      }
    }
  };

  // A review left queued or running is one a restart cut short. Its upload is gone with the
  // source; the member uploads again.
  for (const upload of all()) {
    if (upload.status === "queued" || upload.status === "running") {
      fs.rmSync(workDir(upload.id), { recursive: true, force: true });
      const { phase: _phase, ...rest } = upload;
      save({
        ...rest,
        status: "failed",
        finished_at: now().toISOString(),
        message: "AdminBot restarted before this review finished. Upload the zip again.",
      });
    }
  }
  prune();

  type Finished = Pick<
    PaperMentorUpload,
    "status" | "message" | "comments" | "by_severity" | "pdf" | "files" | "references"
  >;

  /** The reference half of a review, run while the extracted source is still on disk. */
  const checkReferences = async (
    upload: PaperMentorUpload,
    work: string,
    outDir: string,
  ): Promise<PaperMentorReferenceSummary> => {
    const check = options.checkReferences!;
    let bib: ReturnType<typeof citedBibReferences>;
    try {
      bib = citedBibReferences(path.join(work, "paper"));
    } catch {
      // An unreadable source bibliography is reported like a missing one, never guessed at.
      bib = undefined;
    }
    if (!bib) {
      return {
        status: "skipped",
        message:
          "The references were not checked: the zip has no .bib file or \\bibitem list with the entries the paper cites.",
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.referenceTimeoutMs);
    try {
      const report = await check({
        memberId: upload.requested_by,
        references: bib.references,
        signal: controller.signal,
      });
      const target = path.join(outDir, FILE_NAMES.references.name);
      fs.writeFileSync(
        target,
        JSON.stringify({ source: "bib", findings: report.findings }, null, 2),
        { mode: 0o600 },
      );
      const count = (status: ReferenceFinding["status"]) =>
        report.findings.filter((finding) => finding.status === status).length;
      return {
        status: "checked",
        source: "bib",
        total: report.findings.length,
        matched: count("matched"),
        needs_review: count("review"),
        not_found: count("not_found"),
        unavailable: count("unavailable"),
        ...(bib.skipped ? { skipped_entries: bib.skipped } : {}),
      };
    } catch (error) {
      return {
        status: "failed",
        source: "bib",
        // The checker's own errors are fixed sentences about the paper's shape; anything else may
        // carry a database's answer, which is not ours to relay.
        message: controller.signal.aborted
          ? "The reference check ran out of time. The databases may be rate-limiting; try again later."
          : error instanceof ReferenceCheckError
            ? error.message
            : "The reference check could not be completed.",
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const run = async (
    upload: PaperMentorUpload,
    input: PaperMentorUploadSubmission,
    setPhase: (phase: "references") => void,
  ) => {
    const outDir = path.join(jobDir(upload.id), "out");
    const work = workDir(upload.id);
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    const logFile = path.join(jobDir(upload.id), "run.log");
    // papermentor extracts `paper.zip` into `paper/` beside it and reviews it there, so the cwd it
    // runs in holds nothing but the upload.
    const zipPath = path.join(work, "paper.zip");
    fs.writeFileSync(zipPath, input.zip, { mode: 0o600 });
    const deadline = Date.now() + limits.timeoutMs;
    const remaining = () => Math.max(60_000, deadline - Date.now());
    const childEnv = reviewerEnv(env);
    const cli = path.join(options.pdfDir, "bin", "papermentor.mjs");
    const call = (command: "review" | "annotate", build: BuildEngine) =>
      spawn(
        node,
        [
          cli,
          command,
          zipPath,
          "--json",
          "--engine",
          build,
          ...(command === "review"
            ? ["--venue", upload.venue, ...(model ? ["--model", model] : [])]
            : []),
        ],
        { cwd: work, env: childEnv, timeoutMs: remaining(), logFile },
      );

    let result = await call("review", engine);
    let answer = lastJson(result.stdout);
    const error = asRecord(answer?.error);
    let built = engine !== "none";
    if (result.code !== 0 && error) {
      if (error.reviewSaved === true) {
        // The paid review is saved and only the build failed: finish it without a PDF. No model
        // call -- `annotate` re-places the saved review.
        result = await call("annotate", "none");
        built = false;
      } else if (/No LaTeX compiler found|is not on PATH/u.test(String(error.message ?? ""))) {
        // papermentor checks the compiler before the first model call, so nothing was spent yet.
        result = await call("review", "none");
        built = false;
      }
      answer = lastJson(result.stdout);
    }
    if (result.code !== 0 || !answer || answer.error) {
      return reviewFailure(asRecord(answer?.error));
    }

    // Only files papermentor wrote inside this review's own work folder are handed out.
    // The files papermentor writes itself; `references` is written by the step below.
    const sources: Partial<Record<PaperMentorUploadFileKind, unknown>> = {
      commented_zip: answer.commentedZip,
      reviewed_pdf: answer.outPdf,
      report: answer.reportPath,
      edits_diff: answer.diffPath,
    };
    const files: PaperMentorUploadFileKind[] = [];
    for (const kind of paperMentorUploadFileKinds) {
      const source = sources[kind];
      if (typeof source === "string" && isInside(work, source) && fs.existsSync(source)) {
        const target = path.join(outDir, FILE_NAMES[kind].name);
        fs.copyFileSync(source, target);
        fs.chmodSync(target, 0o600);
        files.push(kind);
      }
    }
    if (!files.includes("commented_zip")) {
      return {
        status: "failed",
        message: "PaperMentor finished but did not write the reviewed zip.",
        files: [],
      } satisfies Finished;
    }
    const pdf = built && files.includes("reviewed_pdf");
    let references: PaperMentorReferenceSummary | undefined;
    if (input.check_references && options.checkReferences) {
      setPhase("references");
      references = await checkReferences(upload, work, outDir);
      if (references.status === "checked") {
        files.push("references");
      }
    }
    return {
      status: "reviewed",
      comments: countOf(answer.comments),
      by_severity: severityCounts(answer.bySeverity),
      pdf,
      files,
      ...(references ? { references } : {}),
    } satisfies Finished;
  };

  const kick = () => {
    if (running) {
      return;
    }
    const next = queue.shift();
    if (!next) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
      return;
    }
    let started: PaperMentorUpload = {
      ...next.upload,
      status: "running",
      phase: "review",
      started_at: now().toISOString(),
    };
    running = started;
    save(started);
    const setPhase = (phase: "references") => {
      started = { ...started, phase };
      running = started;
      save(started);
    };
    void run(started, next.input, setPhase)
      .catch(
        (): Finished => ({
          status: "failed",
          message: "The review stopped unexpectedly.",
          files: [],
        }),
      )
      .then(async (finished) => {
        // The source and papermentor's own working files go now; only what the member downloads
        // (and the log) stays until retention.
        fs.rmSync(workDir(started.id), { recursive: true, force: true });
        const { phase: _phase, ...rest } = started;
        const upload: PaperMentorUpload = {
          ...rest,
          ...finished,
          finished_at: now().toISOString(),
        };
        save(upload);
        running = undefined;
        try {
          await next.input.onFinished?.(upload);
        } catch {
          // The review is done and saved; a failed notice must not stop the queue.
        }
        kick();
      });
  };

  const venues = (): string[] => {
    try {
      const dir = path.join(options.pdfDir, "src", "engine", "ai-tutor-skills", "02_venues");
      return [
        "arxiv",
        ...fs
          .readdirSync(dir)
          .filter((file) => file.endsWith(".md") && file !== "arxiv_default.md")
          .map((file) => file.replace(/\.md$/u, ""))
          .toSorted(),
      ];
    } catch {
      return ["arxiv"];
    }
  };

  const submit = (input: PaperMentorUploadSubmission): PaperMentorUploadSubmitResult => {
    if (input.zip.length > limits.maxZipBytes) {
      return {
        ok: false,
        status: 413,
        message: `Zips must be ${Math.floor(limits.maxZipBytes / (1024 * 1024))} MB or smaller.`,
      };
    }
    if (!isZip(input.zip)) {
      return {
        ok: false,
        status: 400,
        message: "That is not a zip file. In Overleaf, use Menu → Download → Source.",
      };
    }
    prune();
    const current = active();
    if (current.some((upload) => upload.requested_by === input.requested_by)) {
      return {
        ok: false,
        status: 429,
        message: "You already have a review waiting or running. Wait for it to finish.",
      };
    }
    const since = now().getTime() - DAY_MS;
    const today = all().filter(
      (upload) =>
        upload.requested_by === input.requested_by && Date.parse(upload.created_at) >= since,
    );
    if (today.length >= limits.perMemberPerDay) {
      return {
        ok: false,
        status: 429,
        message: `You have asked for ${limits.perMemberPerDay} reviews in the last day, which is the limit. Try again tomorrow.`,
      };
    }
    if (current.length >= limits.queue) {
      return {
        ok: false,
        status: 429,
        message: "PaperMentor is busy. Try again in a little while.",
      };
    }
    const known = venues();
    const upload: PaperMentorUpload = {
      id: `pm_${randomBytes(8).toString("hex")}`,
      requested_by: input.requested_by,
      label: cleanLabel(input.label),
      venue: input.venue && known.includes(input.venue) ? input.venue : "arxiv",
      status: "queued",
      ...(input.check_references && options.checkReferences ? { check_references: true } : {}),
      created_at: now().toISOString(),
      files: [],
    };
    save(upload);
    queue.push({ upload, input });
    kick();
    return { ok: true, upload: load(upload.id) ?? upload };
  };

  return {
    submit,
    uploadsFor: (memberId) => all().filter((upload) => upload.requested_by === memberId),
    upload: load,
    file(id, kind) {
      const upload = load(id);
      if (!upload?.files.includes(kind)) {
        return undefined;
      }
      const file = path.join(jobDir(id), "out", FILE_NAMES[kind].name);
      if (!fs.existsSync(file)) {
        return undefined;
      }
      const stem = upload.label
        .replace(/[^A-Za-z0-9._-]+/gu, "-")
        .replace(/^[-.]+|-+$/gu, "")
        .slice(0, 60);
      return {
        filename: `${stem || "paper"}.${FILE_NAMES[kind].suffix}`,
        media_type: FILE_NAMES[kind].media_type,
        path: file,
      };
    },
    venues,
    modelProvider: modelProviderName(env),
    maxZipBytes: limits.maxZipBytes,
    checksReferences: Boolean(options.checkReferences),
    idle: () =>
      running || queue.length
        ? new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          })
        : Promise.resolve(),
  };
}

/**
 * The reviewer this deployment is configured for, or nothing.
 *
 * On when `ADMINBOT_PAPERMENTOR_PDF_DIR` names an install that has its CLI; the install script
 * (deploy/aurora/install-papermentor-pdf.sh) sets it. Off, the tab says reviews are not set up.
 */
export function paperMentorUploadReviewerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: { checkReferences?: PaperMentorReferenceCheck } = {},
): PaperMentorUploadReviewer | undefined {
  const pdfDir = env[ADMINBOT_PAPERMENTOR_PDF_DIR_ENV]?.trim();
  if (!pdfDir || !fs.existsSync(path.join(pdfDir, "bin", "papermentor.mjs"))) {
    return undefined;
  }
  const workRoot =
    env.ADMINBOT_PAPERMENTOR_WORK_DIR?.trim() || path.resolve("state", "papermentor");
  return createPaperMentorUploadReviewer({ pdfDir, workRoot, env, ...deps });
}

/**
 * The environment a review runs with: what it needs and nothing else -- no service tokens, no gog
 * keyring password, no Slack token. With the lab's LLM gateway configured, the review goes through
 * its public route (docs/tools/llm-gateway.md), so it counts against the shared limits.
 *
 * The provider keys are blank rather than absent when unused, so papermentor-pdf's own `.env`
 * loader (which fills only unset variables) cannot supply a different one from its install folder.
 */
export function reviewerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extraBin = env.ADMINBOT_PAPERMENTOR_BIN_DIR?.trim();
  const home = env.HOME ?? os.homedir();
  const out: NodeJS.ProcessEnv = {
    PATH: [extraBin, path.join(home, ".local", "bin"), env.PATH]
      .filter(Boolean)
      .join(path.delimiter),
    HOME: home,
    LANG: env.LANG ?? "C.UTF-8",
    ...(env.TMPDIR ? { TMPDIR: env.TMPDIR } : {}),
    ...(env.XDG_CACHE_HOME ? { XDG_CACHE_HOME: env.XDG_CACHE_HOME } : {}),
    OPENROUTER_API_KEY: "",
    OPENROUTER_BASE_URL: "",
    OPENAI_API_KEY: "",
    SEMANTIC_SCHOLAR_API_KEY: "",
  };
  const gateway = env.LLM_GATEWAY_URL?.trim();
  const gatewayToken = env.LLM_GATEWAY_TOKEN?.trim();
  if (gateway && gatewayToken) {
    out.OPENROUTER_API_KEY = gatewayToken;
    out.OPENROUTER_BASE_URL = `${gateway.replace(/\/+$/u, "")}/public/v1`;
  } else if (env.OPENROUTER_API_KEY?.trim()) {
    out.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY.trim();
  } else if (env.OPENAI_API_KEY?.trim()) {
    out.OPENAI_API_KEY = env.OPENAI_API_KEY.trim();
  }
  return out;
}

function modelProviderName(env: NodeJS.ProcessEnv): string {
  if (env.LLM_GATEWAY_URL?.trim() && env.LLM_GATEWAY_TOKEN?.trim()) {
    return "the lab's LLM gateway (OpenRouter)";
  }
  if (env.OPENROUTER_API_KEY?.trim()) {
    return "OpenRouter";
  }
  return env.OPENAI_API_KEY?.trim() ? "OpenAI" : "no model provider (not configured)";
}

/**
 * A review that failed, in fixed words. The child's own message can quote LaTeX from the paper, so
 * it stays in the review's run.log on this disk and never reaches the audit table or the browser.
 */
function reviewFailure(error: Record<string, unknown> | undefined) {
  const message = String(error?.message ?? "");
  if (/No API key set/u.test(message)) {
    return {
      status: "failed" as const,
      message: "PaperMentor has no model provider configured on this host. Tell an admin.",
      files: [],
    };
  }
  if (/^Could not find root \.tex file|has no files$/u.test(message)) {
    return {
      status: "rejected" as const,
      message:
        "No LaTeX paper was found in the zip (a .tex file with \\documentclass). Upload the Overleaf source zip: Menu → Download → Source.",
      files: [],
    };
  }
  if (/^(Not a zip file|Corrupt zip|Zip)/u.test(message)) {
    return {
      status: "rejected" as const,
      message: "The zip could not be read. Download it from Overleaf again and upload that.",
      files: [],
    };
  }
  return {
    status: "failed" as const,
    message: "The review did not finish. An admin can read its log on the AdminBot host.",
    files: [],
  };
}

function cleanLabel(label: string): string {
  // Control characters out; the label is shown in the tab and used for the download's name.
  // eslint-disable-next-line no-control-regex
  const clean = label.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\.zip$/iu, "");
  return clean.trim().slice(0, 200) || "Uploaded paper";
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function severityCounts(value: unknown): Record<string, number> {
  const record = asRecord(value) ?? {};
  const out: Record<string, number> = {};
  for (const key of ["critical", "warning", "suggestion"]) {
    out[key] = countOf(record[key]);
  }
  return out;
}

function lastJson(stdout: string): Record<string, unknown> | undefined {
  const line = stdout.trim().split("\n").at(-1);
  if (!line) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** A zip with at least one entry: a local file header up front. An empty zip has none. */
function isZip(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

/** Runs a child with stderr appended to the review's log, stdout collected, and a hard timeout. */
const spawnLogged: PaperMentorSpawn = (command, args, options) =>
  new Promise((resolve) => {
    const log = fs.openSync(options.logFile, "a", 0o600);
    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", log],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_000_000) {
        stdout += chunk.toString("utf8");
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, options.timeoutMs);
    let settled = false;
    const done = (code: number | null) => {
      // 'error' and 'close' can both fire for one child.
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fs.closeSync(log);
      resolve({ code, stdout });
    };
    child.on("error", () => done(1));
    child.on("close", done);
  });
