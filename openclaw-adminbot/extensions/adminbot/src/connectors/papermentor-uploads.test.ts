import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPaperMentorUploadReviewer,
  paperMentorUploadReviewerFromEnv,
  reviewerEnv,
  type PaperMentorReferenceCheck,
  type PaperMentorSpawn,
} from "./papermentor-uploads.js";
import { ReferenceCheckError, referenceCitation } from "./reference-check.js";

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("synthetic")]);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-papermentor-uploads-"));
  dirs.push(dir);
  return dir;
}

type Call = { args: string[]; env: NodeJS.ProcessEnv; cwd: string };

/** papermentor-pdf's CLI, faked: writes the outputs a review leaves beside the extracted zip. */
function fakeCli(
  behave: (call: Call, calls: Call[]) => { code: number; stdout: string } | undefined = () =>
    undefined,
) {
  const calls: Call[] = [];
  const spawn: PaperMentorSpawn = async (_command, args, options) => {
    const call = { args, env: options.env, cwd: options.cwd };
    calls.push(call);
    const custom = behave(call, calls);
    if (custom) {
      return custom;
    }
    const zipPath = args[2]!;
    const outDir = path.join(path.dirname(zipPath), "paper", "papermentor");
    fs.mkdirSync(outDir, { recursive: true });
    const built = args[args.indexOf("--engine") + 1] !== "none";
    const pdf = path.join(outDir, "main.reviewed.pdf");
    const report = path.join(outDir, "review.md");
    const commented = path.join(outDir, "paper.commented.zip");
    if (built) {
      fs.writeFileSync(pdf, "%PDF-synthetic-reviewed");
    }
    fs.writeFileSync(report, "# Synthetic review");
    fs.writeFileSync(commented, ZIP);
    return {
      code: 0,
      stdout: `progress line\n${JSON.stringify({
        comments: 3,
        bySeverity: { critical: 1, warning: 2 },
        outPdf: built ? pdf : null,
        reportPath: report,
        commentedZip: commented,
        diffPath: null,
      })}\n`,
    };
  };
  return { calls, spawn };
}

function reviewer(
  spawn: PaperMentorSpawn,
  options: Partial<Parameters<typeof createPaperMentorUploadReviewer>[0]> = {},
) {
  const root = tmp();
  return {
    root,
    reviewer: createPaperMentorUploadReviewer({
      pdfDir: tmp(),
      workRoot: path.join(root, "papermentor"),
      env: { OPENROUTER_API_KEY: "synthetic-or" },
      node: "/synthetic/node",
      spawn,
      ...options,
    }),
  };
}

describe("PaperMentor upload reviewer", () => {
  it("reviews an upload and hands back the post-review zip, PDF and report", async () => {
    const { calls, spawn } = fakeCli();
    const { reviewer: pm, root } = reviewer(spawn);
    const submitted = pm.submit({ requested_by: "ada", label: "My Paper.zip", zip: ZIP });
    expect(submitted.ok).toBe(true);
    await pm.idle();

    const [upload] = pm.uploadsFor("ada");
    expect(upload).toMatchObject({
      label: "My Paper",
      venue: "arxiv",
      status: "reviewed",
      comments: 3,
      by_severity: { critical: 1, warning: 2, suggestion: 0 },
      pdf: true,
      files: ["commented_zip", "reviewed_pdf", "report"],
    });
    expect(pm.uploadsFor("ben")).toEqual([]);
    const zip = pm.file(upload!.id, "commented_zip")!;
    expect(zip).toMatchObject({
      filename: "My-Paper.papermentor.zip",
      media_type: "application/zip",
    });
    expect(fs.readFileSync(zip.path)).toEqual(ZIP);
    expect(pm.file(upload!.id, "edits_diff")).toBeUndefined();

    // The CLI ran on the upload, in its own folder, with the venue and a safe build.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(1, 3)).toEqual(["review", expect.stringMatching(/paper\.zip$/u)]);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--json", "--venue", "arxiv"]));
    // The extracted source is gone once the review ends; only what is handed out stays.
    const jobDir = path.join(root, "papermentor", "uploads", upload!.id);
    expect(fs.existsSync(path.join(jobDir, "work"))).toBe(false);
    expect(fs.readdirSync(path.join(jobDir, "out")).toSorted()).toEqual([
      "commented.zip",
      "review.md",
      "reviewed.pdf",
    ]);
  });

  it("never builds an upload with latexmk, whatever the environment asks for", async () => {
    for (const asked of [undefined, "auto", "latexmk", "tectonic"]) {
      const { calls, spawn } = fakeCli();
      const { reviewer: pm } = reviewer(spawn, {
        env: { OPENROUTER_API_KEY: "k", ...(asked ? { ADMINBOT_PAPERMENTOR_ENGINE: asked } : {}) },
      });
      pm.submit({ requested_by: "ada", label: "p", zip: ZIP });
      await pm.idle();
      expect(calls[0]!.args[calls[0]!.args.indexOf("--engine") + 1]).toBe("tectonic");
    }
    const { calls, spawn } = fakeCli();
    const { reviewer: pm } = reviewer(spawn, {
      env: { OPENROUTER_API_KEY: "k", ADMINBOT_PAPERMENTOR_ENGINE: "none" },
    });
    pm.submit({ requested_by: "ada", label: "p", zip: ZIP });
    await pm.idle();
    expect(calls[0]!.args[calls[0]!.args.indexOf("--engine") + 1]).toBe("none");
    expect(pm.uploadsFor("ada")[0]).toMatchObject({ status: "reviewed", pdf: false });
  });

  it("falls back to no PDF when Tectonic is missing, before any model call", async () => {
    const { calls, spawn } = fakeCli((call) =>
      call.args.includes("tectonic")
        ? {
            code: 1,
            stdout: `${JSON.stringify({
              error: { message: "tectonic is not on PATH. Install …", reviewSaved: false },
            })}\n`,
          }
        : undefined,
    );
    const { reviewer: pm } = reviewer(spawn);
    pm.submit({ requested_by: "ada", label: "p", zip: ZIP });
    await pm.idle();
    expect(calls.map((call) => call.args[1])).toEqual(["review", "review"]);
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["--engine", "none"]));
    expect(pm.uploadsFor("ada")[0]).toMatchObject({
      status: "reviewed",
      pdf: false,
      files: ["commented_zip", "report"],
    });
  });

  it("finishes a saved review without a PDF when only the build failed, with no second review", async () => {
    const { calls, spawn } = fakeCli((call) =>
      call.args[1] === "review"
        ? {
            code: 1,
            stdout: `${JSON.stringify({
              error: { message: "tectonic did not produce a PDF.", reviewSaved: true },
            })}\n`,
          }
        : undefined,
    );
    const { reviewer: pm } = reviewer(spawn);
    pm.submit({ requested_by: "ada", label: "p", zip: ZIP });
    await pm.idle();
    expect(calls.map((call) => call.args[1])).toEqual(["review", "annotate"]);
    expect(calls[1]!.args).not.toContain("--venue");
    expect(pm.uploadsFor("ada")[0]).toMatchObject({ status: "reviewed", pdf: false });
  });

  it("says why a review failed in its own words, never the child's", async () => {
    const cases: Array<[string, string, RegExp]> = [
      [
        "Could not find root .tex file with \\documentclass (use --main to name it)",
        "rejected",
        /No LaTeX paper was found/u,
      ],
      ["Zip entry points outside the folder: ../../etc/passwd", "rejected", /could not be read/u],
      ["No API key set. Put OPENROUTER_API_KEY …", "failed", /no model provider/u],
      ["Secret Garden Theorem \\cite{x} broke", "failed", /did not finish/u],
    ];
    for (const [childMessage, status, ours] of cases) {
      const { spawn } = fakeCli(() => ({
        code: 1,
        stdout: `${JSON.stringify({ error: { message: childMessage, reviewSaved: false } })}\n`,
      }));
      const { reviewer: pm } = reviewer(spawn);
      pm.submit({ requested_by: "ada", label: "p", zip: ZIP });
      await pm.idle();
      const [upload] = pm.uploadsFor("ada");
      expect(upload).toMatchObject({ status, files: [] });
      expect(upload!.message).toMatch(ours);
      expect(JSON.stringify(upload)).not.toContain(childMessage.slice(0, 20));
    }
  });

  it("hands out only files written inside the review's own work folder", async () => {
    const elsewhere = path.join(tmp(), "secret.pdf");
    fs.writeFileSync(elsewhere, "%PDF-not-yours");
    const { spawn } = fakeCli((call) => {
      const outDir = path.join(path.dirname(call.args[2]!), "paper", "papermentor");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "c.zip"), ZIP);
      return {
        code: 0,
        stdout: `${JSON.stringify({
          comments: 1,
          outPdf: elsewhere,
          reportPath: "/etc/hostname",
          commentedZip: path.join(outDir, "c.zip"),
        })}\n`,
      };
    });
    const { reviewer: pm } = reviewer(spawn);
    pm.submit({ requested_by: "ada", label: "p", zip: ZIP });
    await pm.idle();
    expect(pm.uploadsFor("ada")[0]).toMatchObject({
      status: "reviewed",
      pdf: false,
      files: ["commented_zip"],
    });
  });

  it("refuses what is not a zip, a zip over the cap, and too many reviews", async () => {
    const { spawn } = fakeCli();
    const { reviewer: pm } = reviewer(spawn, { limits: { maxZipBytes: 64, perMemberPerDay: 2 } });
    expect(
      pm.submit({ requested_by: "ada", label: "p", zip: Buffer.from("%PDF-1.7") }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      pm.submit({ requested_by: "ada", label: "p", zip: Buffer.concat([ZIP, Buffer.alloc(64)]) }),
    ).toMatchObject({ ok: false, status: 413 });

    expect(pm.submit({ requested_by: "ada", label: "p", zip: ZIP }).ok).toBe(true);
    // One at a time per member.
    expect(pm.submit({ requested_by: "ada", label: "p", zip: ZIP })).toMatchObject({
      ok: false,
      status: 429,
    });
    await pm.idle();
    expect(pm.submit({ requested_by: "ada", label: "p", zip: ZIP }).ok).toBe(true);
    await pm.idle();
    // Two a day.
    expect(pm.submit({ requested_by: "ada", label: "p", zip: ZIP })).toMatchObject({
      ok: false,
      status: 429,
      message: expect.stringContaining("2 reviews in the last day"),
    });
    expect(pm.submit({ requested_by: "ben", label: "p", zip: ZIP }).ok).toBe(true);
    await pm.idle();
  });

  it("keeps an unknown venue from reaching the CLI", async () => {
    const { calls, spawn } = fakeCli();
    const pdfDir = tmp();
    const venues = path.join(pdfDir, "src", "engine", "ai-tutor-skills", "02_venues");
    fs.mkdirSync(venues, { recursive: true });
    for (const file of ["arxiv_default.md", "iclr_2026.md", "acl_2026.md"]) {
      fs.writeFileSync(path.join(venues, file), "");
    }
    const { reviewer: pm } = reviewer(spawn, { pdfDir });
    expect(pm.venues()).toEqual(["arxiv", "acl_2026", "iclr_2026"]);
    pm.submit({ requested_by: "ada", label: "p", venue: "iclr_2026", zip: ZIP });
    await pm.idle();
    pm.submit({ requested_by: "ben", label: "p", venue: "--engine latexmk", zip: ZIP });
    await pm.idle();
    expect(calls.map((call) => call.args[call.args.indexOf("--venue") + 1])).toEqual([
      "iclr_2026",
      "arxiv",
    ]);
  });

  it("marks a review a restart cut short as failed, and deletes reviews past retention", () => {
    const root = tmp();
    const workRoot = path.join(root, "papermentor");
    const day = (n: number) => new Date(Date.UTC(2026, 10, n, 12));
    const write = (id: string, created: Date, status: string) => {
      const dir = path.join(workRoot, "uploads", id);
      fs.mkdirSync(path.join(dir, "work"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "job.json"),
        JSON.stringify({
          id,
          requested_by: "ada",
          label: "p",
          venue: "arxiv",
          status,
          created_at: created.toISOString(),
          files: [],
        }),
      );
    };
    write("pm_00000000000000aa", day(1), "reviewed");
    write("pm_00000000000000bb", day(20), "running");
    const { spawn } = fakeCli();
    const pm = createPaperMentorUploadReviewer({
      pdfDir: tmp(),
      workRoot,
      env: {},
      spawn,
      now: () => day(20),
    });
    expect(pm.upload("pm_00000000000000aa")).toBeUndefined();
    expect(pm.upload("pm_00000000000000bb")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("restarted"),
    });
    expect(fs.existsSync(path.join(workRoot, "uploads", "pm_00000000000000bb", "work"))).toBe(
      false,
    );
    expect(pm.upload("../../etc")).toBeUndefined();
  });

  it("calls back once a review ends, and a failing callback does not stop the queue", async () => {
    const { spawn } = fakeCli();
    const { reviewer: pm } = reviewer(spawn);
    const seen: string[] = [];
    pm.submit({
      requested_by: "ada",
      label: "p",
      zip: ZIP,
      onFinished: (upload) => {
        seen.push(upload.status);
        throw new Error("synthetic notice failure");
      },
    });
    pm.submit({
      requested_by: "ben",
      label: "q",
      zip: ZIP,
      onFinished: (u) => void seen.push(u.status),
    });
    await pm.idle();
    expect(seen).toEqual(["reviewed", "reviewed"]);
  });
});

describe("reviewerEnv", () => {
  it("passes a review nothing but what it needs, and routes it through the lab's gateway", () => {
    const env = reviewerEnv({
      PATH: "/usr/bin",
      HOME: "/home/synthetic",
      ADMINBOT_SERVICE_TOKEN: "synthetic-service-token",
      SLACK_BOT_TOKEN: "xoxb-synthetic",
      GOG_KEYRING_PASSWORD: "synthetic",
      ADMINBOT_PAPERMENTOR_BIN_DIR: "/opt/pm/bin",
      LLM_GATEWAY_URL: "http://127.0.0.1:8766/",
      LLM_GATEWAY_TOKEN: "synthetic-gateway",
      OPENROUTER_API_KEY: "synthetic-direct",
    });
    expect(env).toEqual({
      PATH: ["/opt/pm/bin", "/home/synthetic/.local/bin", "/usr/bin"].join(path.delimiter),
      HOME: "/home/synthetic",
      LANG: "C.UTF-8",
      OPENROUTER_API_KEY: "synthetic-gateway",
      OPENROUTER_BASE_URL: "http://127.0.0.1:8766/public/v1",
      OPENAI_API_KEY: "",
      SEMANTIC_SCHOLAR_API_KEY: "",
    });
  });

  it("blanks the keys it does not use, so papermentor's own .env cannot supply one", () => {
    expect(reviewerEnv({ HOME: "/h", OPENAI_API_KEY: "synthetic-openai" })).toMatchObject({
      OPENROUTER_API_KEY: "",
      OPENROUTER_BASE_URL: "",
      OPENAI_API_KEY: "synthetic-openai",
    });
    expect(reviewerEnv({ HOME: "/h" })).toMatchObject({
      OPENROUTER_API_KEY: "",
      OPENAI_API_KEY: "",
    });
  });
});

describe("paperMentorUploadReviewerFromEnv", () => {
  it("is off until the install it names has its CLI", () => {
    expect(paperMentorUploadReviewerFromEnv({})).toBeUndefined();
    const pdfDir = tmp();
    expect(
      paperMentorUploadReviewerFromEnv({ ADMINBOT_PAPERMENTOR_PDF_DIR: pdfDir }),
    ).toBeUndefined();
    fs.mkdirSync(path.join(pdfDir, "bin"));
    fs.writeFileSync(path.join(pdfDir, "bin", "papermentor.mjs"), "");
    const pm = paperMentorUploadReviewerFromEnv({
      ADMINBOT_PAPERMENTOR_PDF_DIR: pdfDir,
      ADMINBOT_PAPERMENTOR_WORK_DIR: path.join(tmp(), "work"),
      OPENROUTER_API_KEY: "synthetic",
    });
    expect(pm?.modelProvider).toBe("OpenRouter");
  });
});

describe("the reference check in a review", () => {
  /** The CLI fake, plus the paper's own source extracted beside the upload. */
  function withSource(files: Record<string, string>) {
    return fakeCli((call) => {
      const dir = path.join(path.dirname(call.args[2]!), "paper");
      for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
      }
      return undefined;
    });
  }

  function lookup(
    answer: (input: Parameters<PaperMentorReferenceCheck>[0]) => Promise<{
      findings: Array<{
        citation: string;
        status: "matched" | "review" | "not_found" | "unavailable";
        explanation: string;
      }>;
    }>,
  ) {
    const seen: Array<Parameters<PaperMentorReferenceCheck>[0]> = [];
    const check: PaperMentorReferenceCheck = async (input) => {
      seen.push(input);
      return answer(input);
    };
    return { seen, check };
  }

  const SOURCE = {
    "main.tex": String.raw`\documentclass{article}\begin{document}\cite{a2020}\bibliography{refs}\end{document}`,
    "refs.bib": String.raw`@article{a2020, title={Synthetic Results}, author={Lovelace, Ada}, year={2020}}`,
  };

  it("checks the cited .bib entries once the review is done, and keeps the findings as a file", async () => {
    const { spawn } = withSource(SOURCE);
    const { seen, check } = lookup(async (input) => ({
      findings: [
        {
          citation: referenceCitation(input.references[0]!),
          status: "not_found",
          explanation: "No matching reference found in the available databases.",
        },
      ],
    }));
    const { reviewer: pm } = reviewer(spawn, { checkReferences: check });
    expect(pm.checksReferences).toBe(true);
    pm.submit({ requested_by: "ada", label: "p", zip: ZIP, check_references: true });
    await pm.idle();

    expect(seen).toEqual([
      expect.objectContaining({
        memberId: "ada",
        // The .bib entry's own fields, not a citation string for the lookup to re-parse.
        references: [
          {
            citation: "Ada Lovelace. 2020. Synthetic Results.",
            title: "Synthetic Results",
            authors: "Ada Lovelace",
            year: "2020",
          },
        ],
      }),
    ]);
    const [upload] = pm.uploadsFor("ada");
    expect(upload).toMatchObject({
      status: "reviewed",
      check_references: true,
      files: ["commented_zip", "reviewed_pdf", "report", "references"],
      references: {
        status: "checked",
        source: "bib",
        total: 1,
        matched: 0,
        needs_review: 0,
        not_found: 1,
        unavailable: 0,
      },
    });
    expect(upload).not.toHaveProperty("phase");
    const file = pm.file(upload!.id, "references")!;
    expect(file.media_type).toBe("application/json; charset=utf-8");
    expect(JSON.parse(fs.readFileSync(file.path, "utf8"))).toEqual({
      source: "bib",
      findings: [expect.objectContaining({ status: "not_found" })],
    });
  });

  it("never reads the built PDF: a zip with no .bib or \\bibitem list is not checked", async () => {
    // The PDF is built (the fake CLI writes one), yet nothing is looked up.
    const { spawn } = withSource({ "main.tex": "\\documentclass{article}\\cite{a2020}" });
    const { seen, check } = lookup(async () => ({ findings: [] }));
    const { reviewer: pm } = reviewer(spawn, { checkReferences: check });
    pm.submit({ requested_by: "ada", label: "p", zip: ZIP, check_references: true });
    await pm.idle();
    expect(seen).toEqual([]);
    const [upload] = pm.uploadsFor("ada");
    expect(upload).toMatchObject({
      status: "reviewed",
      pdf: true,
      files: ["commented_zip", "reviewed_pdf", "report"],
      references: { status: "skipped", message: expect.stringContaining("\\bibitem") },
    });
  });

  it("reads a hand-written \\bibitem list when the zip has no .bib", async () => {
    const { spawn } = withSource({
      "main.tex": String.raw`\documentclass{article}\begin{document}\cite{a2020}
\begin{thebibliography}{1}
\bibitem{a2020} Ada Lovelace. 2020. Synthetic Results.
\end{thebibliography}
\end{document}`,
    });
    const { seen, check } = lookup(async () => ({ findings: [] }));
    const { reviewer: pm } = reviewer(spawn, { checkReferences: check });
    pm.submit({ requested_by: "ada", label: "p", zip: ZIP, check_references: true });
    await pm.idle();
    expect(seen.map((input) => input.references)).toEqual([
      ["Ada Lovelace. 2020. Synthetic Results."],
    ]);
    expect(pm.uploadsFor("ada")[0]?.references).toMatchObject({ status: "checked", source: "bib" });
  });

  it("keeps the review when the check fails, in the checker's words or fixed ones", async () => {
    for (const [error, message] of [
      [
        new ReferenceCheckError("This checker supports at most 200 references per paper."),
        /at most 200/u,
      ],
      [new Error("Crossref said: Secret Garden Theorem"), /could not be completed/u],
    ] as const) {
      const { spawn } = withSource(SOURCE);
      const { reviewer: pm } = reviewer(spawn, {
        checkReferences: async () => {
          throw error;
        },
      });
      pm.submit({ requested_by: "ada", label: "p", zip: ZIP, check_references: true });
      await pm.idle();
      const [upload] = pm.uploadsFor("ada");
      expect(upload).toMatchObject({
        status: "reviewed",
        files: ["commented_zip", "reviewed_pdf", "report"],
        references: { status: "failed", source: "bib", message: expect.stringMatching(message) },
      });
      expect(JSON.stringify(upload)).not.toContain("Secret Garden");
    }
  });

  it("checks nothing unless the member asked, or with no checker on this host", async () => {
    const { seen, check } = lookup(async () => ({ findings: [] }));
    const asked = reviewer(withSource(SOURCE).spawn, { checkReferences: check }).reviewer;
    asked.submit({ requested_by: "ada", label: "p", zip: ZIP });
    await asked.idle();
    expect(seen).toEqual([]);
    expect(asked.uploadsFor("ada")[0]).not.toHaveProperty("references");

    const unequipped = reviewer(withSource(SOURCE).spawn).reviewer;
    expect(unequipped.checksReferences).toBe(false);
    unequipped.submit({ requested_by: "ada", label: "p", zip: ZIP, check_references: true });
    await unequipped.idle();
    expect(unequipped.uploadsFor("ada")[0]).not.toHaveProperty("check_references");
  });
});
