// The PaperMentor tab end to end, over HTTP: who may upload, who may see, and what a review leaves.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPaperMentorUploadReviewer,
  type PaperMentorReferenceCheck,
  type PaperMentorSpawn,
} from "../connectors/papermentor-uploads.js";
import type { ReferenceListChecker } from "../connectors/reference-check.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import {
  createPaperMentorReferenceCheck,
  type PdfReferenceCheckAudit,
} from "./pdf-reference-check.js";
import { createAdminBotMockService } from "./server.js";

const token = "synthetic-service-token";
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("synthetic")]);
const CONSENT = "send-draft-to-model-provider";

const instances: ReturnType<typeof createAdminBotMockService>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) {
    if (instance.server.listening) {
      await new Promise<void>((resolve) => {
        instance.server.close(() => resolve());
      });
    }
    instance.close();
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-papermentor-tab-"));
  dirs.push(dir);
  return dir;
}

/**
 * papermentor-pdf's CLI, faked: it extracts the upload's source (a synthetic paper citing one .bib
 * entry, which the reference check reads) and writes its outputs beside it.
 */
const spawn: PaperMentorSpawn = async (_command, args) => {
  const paperDir = path.join(path.dirname(args[2]!), "paper");
  const outDir = path.join(paperDir, "papermentor");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(paperDir, "main.tex"), String.raw`\cite{a2020}\bibliography{refs}`);
  fs.writeFileSync(
    path.join(paperDir, "refs.bib"),
    "@article{a2020, title={Synthetic Results}, author={Lovelace, Ada}, year={2020}}",
  );
  const pdf = path.join(outDir, "main.reviewed.pdf");
  const report = path.join(outDir, "review.md");
  const commented = path.join(outDir, "paper.commented.zip");
  fs.writeFileSync(pdf, "%PDF-synthetic-reviewed");
  fs.writeFileSync(report, "# Synthetic review");
  fs.writeFileSync(commented, Buffer.concat([ZIP, Buffer.from("-commented")]));
  return {
    code: 0,
    stdout: `${JSON.stringify({
      comments: 2,
      bySeverity: { critical: 1, suggestion: 1 },
      outPdf: pdf,
      reportPath: report,
      commentedZip: commented,
      diffPath: null,
    })}\n`,
  };
};

async function setup(
  options: { reviewer?: boolean; checkReferences?: PaperMentorReferenceCheck } = {},
) {
  const dir = tmp();
  const reviewer =
    options.reviewer === false
      ? undefined
      : createPaperMentorUploadReviewer({
          pdfDir: tmp(),
          workRoot: path.join(dir, "papermentor"),
          spawn,
          env: { OPENROUTER_API_KEY: "synthetic-or" },
          limits: { maxZipBytes: 1024 },
          ...(options.checkReferences ? { checkReferences: options.checkReferences } : {}),
        });
  const app = createAdminBotMockService({
    databasePath: path.join(dir, "adminbot.sqlite"),
    serviceToken: token,
    sensitiveInfoPath: path.join(dir, "sensitive.md"),
    ...(reviewer ? { paperMentorUploadReviewer: reviewer } : {}),
    calendarInviteRunner: async () => {},
  });
  instances.push(app);
  const base = await app.listen(0);
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("no listening address");
  }
  return { app, reviewer, url: base.replace(":0", `:${address.port}`) };
}

function session(
  app: Awaited<ReturnType<typeof setup>>["app"],
  memberId: string,
  level: "admin" | "member" | "trial" | "external_collaborator" = "member",
) {
  const sessionToken = `${memberId}-session`;
  app.service.upsertLabMember(
    withCompleteProfile({ id: memberId, name: `Synthetic ${memberId}`, privilege_level: level }),
  );
  app.store.saveSession({
    member_id: memberId,
    token_hash: createHash("sha256").update(sessionToken).digest("hex"),
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  return { Authorization: `Bearer ${sessionToken}` };
}

function upload(
  url: string,
  headers: Record<string, string>,
  query: Record<string, string> = { consent: CONSENT, filename: "My Paper" },
  body: Buffer = ZIP,
  type = "application/zip",
) {
  return fetch(`${url}/papermentor/reviews?${new URLSearchParams(query).toString()}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": type },
    body,
  });
}

describe("the PaperMentor tab", () => {
  it("is for full members: trial members, collaborators and visitors are refused", async () => {
    const { app, url } = await setup();
    for (const level of ["trial", "external_collaborator"] as const) {
      const headers = session(app, `m-${level}`, level);
      expect((await fetch(`${url}/papermentor/reviews`, { headers })).status).toBe(403);
      expect((await upload(url, headers)).status).toBe(403);
    }
    expect((await fetch(`${url}/papermentor/reviews`)).status).toBe(401);
    expect((await upload(url, {})).status).toBe(401);
  });

  it("asks before the draft goes to the model, then reviews the zip and hands back the files", async () => {
    const { app, url, reviewer } = await setup();
    const ada = session(app, "ada");
    const overview = await (await fetch(`${url}/papermentor/reviews`, { headers: ada })).json();
    expect(overview).toMatchObject({
      enabled: true,
      model_provider: "OpenRouter",
      venues: ["arxiv"],
      max_zip_bytes: 1024,
      checks_references: false,
      reference_checkers: ["references-validation"],
      reviews: [],
    });

    expect((await upload(url, ada, { filename: "My Paper" })).status).toBe(400);
    expect((await upload(url, ada, undefined, ZIP, "application/pdf")).status).toBe(415);
    expect((await upload(url, ada, undefined, Buffer.alloc(2048, 1))).status).toBe(413);
    expect((await upload(url, ada, undefined, Buffer.from("%PDF-1.7"))).status).toBe(400);

    const started = await upload(url, ada);
    expect(started.status).toBe(202);
    const { review } = await started.json();
    expect(review).toMatchObject({ label: "My Paper", status: expect.any(String) });
    expect(review).not.toHaveProperty("requested_by");
    await reviewer!.idle();

    const listed = (await (await fetch(`${url}/papermentor/reviews`, { headers: ada })).json())
      .reviews;
    expect(listed).toEqual([
      expect.objectContaining({
        id: review.id,
        status: "reviewed",
        comments: 2,
        pdf: true,
        downloads: [
          { kind: "commented_zip", filename: "My-Paper.papermentor.zip" },
          { kind: "reviewed_pdf", filename: "My-Paper.reviewed.pdf" },
          { kind: "report", filename: "My-Paper.review.md" },
        ],
      }),
    ]);

    const zip = await fetch(`${url}/papermentor/reviews/${review.id}/files/commented_zip`, {
      headers: ada,
    });
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-disposition")).toBe(
      'attachment; filename="My-Paper.papermentor.zip"',
    );
    expect(zip.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await zip.arrayBuffer()).toString()).toContain("-commented");
    expect(
      (await fetch(`${url}/papermentor/reviews/${review.id}/files/edits_diff`, { headers: ada }))
        .status,
    ).toBe(404);
    expect(
      (await fetch(`${url}/papermentor/reviews/${review.id}/files/run.log`, { headers: ada }))
        .status,
    ).toBe(404);

    // Ada hears that it is ready, and the ledger has counts but no comment.
    expect(app.store.listMemberNotifications("ada")).toEqual([
      expect.objectContaining({
        kind: "papermentor",
        tab: "adminbotPaperMentor",
        title: "PaperMentor reviewed “My Paper”",
        body: "2 comments. Download the post-review zip and the annotated PDF from the PaperMentor tab.",
      }),
    ]);
    const audit = app.store
      .listAuditEvents()
      .filter((event) => event.type.startsWith("papermentor.upload_"));
    expect(audit.map((event) => [event.type, event.actor])).toEqual(
      expect.arrayContaining([
        ["papermentor.upload_requested", "ada"],
        ["papermentor.upload_finished", "ada"],
      ]),
    );
    expect(audit.find((event) => event.type === "papermentor.upload_finished")?.details).toEqual({
      review_id: review.id,
      status: "reviewed",
      comments: 2,
      critical: 1,
      pdf: true,
    });
  });

  it("shows a review to its uploader alone -- not another member, not an admin", async () => {
    const { app, url, reviewer } = await setup();
    const ada = session(app, "ada");
    const { review } = await (await upload(url, ada)).json();
    await reviewer!.idle();
    for (const [id, level] of [
      ["ben", "member"],
      ["pi", "admin"],
    ] as const) {
      const other = session(app, id, level);
      expect(
        (await (await fetch(`${url}/papermentor/reviews`, { headers: other })).json()).reviews,
      ).toEqual([]);
      expect(
        (
          await fetch(`${url}/papermentor/reviews/${review.id}/files/commented_zip`, {
            headers: other,
          })
        ).status,
      ).toBe(404);
    }
    // An admin uploads and sees their own, like anybody.
    const pi = session(app, "pi", "admin");
    expect((await upload(url, pi)).status).toBe(202);
    await reviewer!.idle();
    expect(
      (await (await fetch(`${url}/papermentor/reviews`, { headers: pi })).json()).reviews,
    ).toHaveLength(1);
  });

  it("refuses an upload from an admin viewing as a member", async () => {
    const { app, url, reviewer } = await setup();
    session(app, "pi", "admin");
    session(app, "ada");
    app.store.saveSession({
      member_id: "ada",
      token_hash: createHash("sha256").update("viewing-as-ada").digest("hex"),
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      impersonated_by: "pi",
    });
    const viewing = { Authorization: "Bearer viewing-as-ada" };
    const refused = await upload(url, viewing);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.message).toContain("Stop viewing as another member");
    expect(reviewer!.uploadsFor("ada")).toEqual([]);
  });

  it("says the tab is off, and refuses uploads, when PaperMentor is not installed", async () => {
    const { app, url } = await setup({ reviewer: false });
    const ada = session(app, "ada");
    expect(await (await fetch(`${url}/papermentor/reviews`, { headers: ada })).json()).toEqual({
      enabled: false,
      model_provider: null,
      venues: [],
      max_zip_bytes: null,
      checks_references: false,
      // The PDF-only check does not need PaperMentor installed.
      reference_checkers: ["references-validation"],
      reviews: [],
    });
    expect((await upload(url, ada)).status).toBe(503);
  });
});

describe("the reference check in the PaperMentor tab", () => {
  it("asks separately before the references go to the databases", async () => {
    const seen: string[] = [];
    const { app, url, reviewer } = await setup({
      checkReferences: async ({ memberId }) => {
        seen.push(memberId);
        return { findings: [] };
      },
    });
    const ada = session(app, "ada");
    expect(
      (await (await fetch(`${url}/papermentor/reviews`, { headers: ada })).json())
        .checks_references,
    ).toBe(true);
    const refused = await upload(url, ada, { consent: CONSENT, check_references: "1" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toContain("scholarly databases");

    const started = await upload(url, ada, {
      consent: CONSENT,
      check_references: "1",
      references_consent: "query-reference-databases",
    });
    expect(started.status).toBe(202);
    expect((await started.json()).review).toMatchObject({ check_references: true });
    await reviewer!.idle();
    expect(seen).toEqual(["ada"]);
    const audit = app.store
      .listAuditEvents()
      .find((event) => event.type === "papermentor.upload_requested");
    expect(audit?.details).toMatchObject({ check_references: true });
    expect(app.store.listMemberNotifications("ada")[0]?.body).toContain(
      "0 references checked: 0 not found, 0 to look at.",
    );
  });

  it("refuses the opt-in where this host cannot check references", async () => {
    const { app, url } = await setup();
    const ada = session(app, "ada");
    expect(
      (
        await upload(url, ada, {
          consent: CONSENT,
          check_references: "1",
          references_consent: "query-reference-databases",
        })
      ).status,
    ).toBe(503);
  });
});

describe("createPaperMentorReferenceCheck", () => {
  it("runs the lookup through the approval gate and audits the hash of what it sent", async () => {
    const audits: PdfReferenceCheckAudit[] = [];
    const lists: unknown[][] = [];
    let fail = false;
    const listChecker: ReferenceListChecker = async (references) => {
      lists.push([...references]);
      if (fail) {
        throw new Error("synthetic: the databases are down");
      }
      return {
        findings: references.map((entry) => ({
          citation: typeof entry === "string" ? entry : entry.citation,
          status: "matched" as const,
          explanation: "A matching record was found.",
        })),
      };
    };
    const check = createPaperMentorReferenceCheck({
      listChecker,
      audit: (event) => audits.push(event),
    });
    const references = [
      {
        citation: "Ada Lovelace. 2020. Synthetic Results.",
        title: "Synthetic Results",
        authors: "Ada Lovelace",
        year: "2020",
      },
      "Alan Turing. 2023. Synthetic Preprints.",
    ];
    const report = await check({
      memberId: "ada",
      references,
      signal: new AbortController().signal,
    });
    expect(report.findings).toHaveLength(2);
    // The structured entry reaches the lookup as it is, not flattened to a string.
    expect(lists).toEqual([references]);
    expect(audits).toEqual([
      {
        actor: "ada",
        checker: "references-validation",
        pdf_sha256: createHash("sha256")
          .update("Ada Lovelace. 2020. Synthetic Results.\nAlan Turing. 2023. Synthetic Preprints.")
          .digest("hex"),
        outcome: "completed",
        papermentor: { input: "bib" },
      },
    ]);

    fail = true;
    await expect(
      check({ memberId: "ada", references, signal: new AbortController().signal }),
    ).rejects.toThrow();
    expect(audits.at(-1)).toMatchObject({ outcome: "failed", papermentor: { input: "bib" } });
  });
});
