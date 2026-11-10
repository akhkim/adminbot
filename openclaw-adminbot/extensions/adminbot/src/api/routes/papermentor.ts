// The PaperMentor tab: a member uploads an Overleaf source zip, PaperMentor reviews it on this host
// (connectors/papermentor-uploads.ts), and the member downloads the post-review zip -- the paper
// with every comment as a `%PAPERMENTOR:` line above its text -- plus the annotated PDF and report.
//
// The PDF Reference Checker is part of this tab now. A review can also look up every reference the
// paper cites (connectors/papermentor-uploads.ts reads them from the .bib), and a member with only
// a PDF still checks it here through POST /reference-check/pdf, whose route is unchanged.
//
// Full members and admins only: each review is a paid run of a dozen model calls, and trial
// members and external collaborators are not who the lab pays for that.
// A review is its uploader's alone. Nobody else lists it or downloads its files, admins included:
// the comments are on somebody's unpublished draft, and the tab is not a way to read one.
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import {
  paperMentorUploadFileKinds,
  type PaperMentorUpload,
  type PaperMentorUploadReviewer,
} from "../../connectors/papermentor-uploads.js";
import { sendJson } from "../server.http.js";
import type { AdminBotPrincipal } from "./context.js";
import { get, post, type Route } from "./router.js";

/** What the member must agree to before their draft's text goes to a model provider. */
export const PAPERMENTOR_CONSENT = "send-draft-to-model-provider";

/**
 * What the member must separately agree to before the cited references go to the scholarly
 * databases. The same words the PDF-only check asks for (api/pdf-reference-check.ts).
 */
export const REFERENCE_CHECK_CONSENT = "query-reference-databases";

const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed"]);

function fullMember(principal: AdminBotPrincipal): string | undefined {
  return principal.kind === "member" &&
    (principal.member.privilege_level === "member" || principal.member.privilege_level === "admin")
    ? principal.member.id
    : undefined;
}

function forbidden(res: Parameters<typeof sendJson>[0]) {
  sendJson(res, 403, { error: { message: "PaperMentor reviews are for full lab members." } });
}

/** The upload, or why not. Stops reading the moment the body passes the cap. */
async function readZip(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ zip: Buffer } | { tooLarge: true }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      return { tooLarge: true };
    }
    chunks.push(bytes);
  }
  return { zip: Buffer.concat(chunks) };
}

/**
 * What the tab is sent about a review: everything on the record but who asked (which is them), and
 * the name each file downloads as -- sent here because a cross-origin fetch cannot read the
 * download's Content-Disposition, and widening the service's CORS exposure for it is not worth it.
 */
function view(upload: PaperMentorUpload, reviewer: PaperMentorUploadReviewer) {
  const { requested_by: _requestedBy, ...rest } = upload;
  return {
    ...rest,
    downloads: upload.files.flatMap((kind) => {
      const file = reviewer.file(upload.id, kind);
      return file ? [{ kind, filename: file.filename }] : [];
    }),
  };
}

export const paperMentorRoutes: readonly Route[] = [
  get("/papermentor/reviews", ({ res, principal, ctx }) => {
    const memberId = fullMember(principal);
    if (!memberId) {
      forbidden(res);
      return;
    }
    const reviewer = ctx.paperMentorUploadReviewer;
    sendJson(res, 200, {
      enabled: Boolean(reviewer),
      model_provider: reviewer?.modelProvider ?? null,
      venues: reviewer?.venues() ?? [],
      max_zip_bytes: reviewer?.maxZipBytes ?? null,
      checks_references: reviewer?.checksReferences ?? false,
      // For the PDF-only check below the form, which runs whether or not PaperMentor is installed.
      reference_checkers: ctx.referenceCheckers,
      reviews: reviewer
        ? reviewer
            .uploadsFor(memberId)
            .slice(0, 50)
            .map((upload) => view(upload, reviewer))
        : [],
    });
  }),
  post("/papermentor/reviews", async ({ req, res, url, principal, ctx }) => {
    const memberId = fullMember(principal);
    if (!memberId) {
      forbidden(res);
      return;
    }
    if (principal.kind === "member" && principal.impersonator) {
      sendJson(res, 403, {
        error: { message: "Stop viewing as another member before uploading a paper." },
      });
      return;
    }
    const reviewer = ctx.paperMentorUploadReviewer;
    if (!reviewer) {
      sendJson(res, 503, {
        error: { message: "PaperMentor is not set up on this AdminBot host yet. Ask an admin." },
      });
      return;
    }
    if (url.searchParams.get("consent") !== PAPERMENTOR_CONSENT) {
      sendJson(res, 400, {
        error: {
          message: `Agree to sending the draft's text to ${reviewer.modelProvider} for the review.`,
        },
      });
      return;
    }
    const checkReferences = url.searchParams.get("check_references") === "1";
    if (checkReferences && url.searchParams.get("references_consent") !== REFERENCE_CHECK_CONSENT) {
      sendJson(res, 400, {
        error: {
          message: "Agree to sending the paper's references to the scholarly databases.",
        },
      });
      return;
    }
    if (checkReferences && !reviewer.checksReferences) {
      sendJson(res, 503, {
        error: { message: "Reference checks are not set up on this AdminBot host." },
      });
      return;
    }
    const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ZIP_TYPES.has(type)) {
      sendJson(res, 415, { error: { message: "Choose a .zip file." } });
      return;
    }
    const tooLarge = () =>
      sendJson(res, 413, {
        error: {
          message: `Zips must be ${Math.floor(reviewer.maxZipBytes / (1024 * 1024))} MB or smaller.`,
        },
      });
    if (Number(req.headers["content-length"]) > reviewer.maxZipBytes) {
      tooLarge();
      return;
    }
    const body = await readZip(req, reviewer.maxZipBytes);
    if ("tooLarge" in body) {
      tooLarge();
      return;
    }
    const submitted = reviewer.submit({
      requested_by: memberId,
      label: url.searchParams.get("filename") ?? "",
      venue: url.searchParams.get("venue") ?? undefined,
      zip: body.zip,
      check_references: checkReferences,
      onFinished: (upload) => ctx.service.finishPaperMentorUpload(memberId, upload),
    });
    if (!submitted.ok) {
      sendJson(res, submitted.status, { error: { message: submitted.message } });
      return;
    }
    ctx.service.auditPaperMentorUpload(memberId, submitted.upload);
    sendJson(res, 202, { review: view(submitted.upload, reviewer) });
  }),
  get(
    // Both captures are checked in the handler: the id by the reviewer, the kind against its list.
    /^\/papermentor\/reviews\/([^/]+)\/files\/([^/]+)$/u,
    ({ res, principal, ctx, params }) => {
      const memberId = fullMember(principal);
      if (!memberId) {
        forbidden(res);
        return;
      }
      const reviewer = ctx.paperMentorUploadReviewer;
      const upload = reviewer?.upload(params[1]!);
      const kind = paperMentorUploadFileKinds.find((entry) => entry === params[2]);
      // Not found rather than forbidden for somebody else's review: its existence is theirs too.
      const file =
        reviewer && upload && kind && upload.requested_by === memberId
          ? reviewer.file(upload.id, kind)
          : undefined;
      if (!file) {
        sendJson(res, 404, { error: { message: "No such review file." } });
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", file.media_type);
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      fs.createReadStream(file.path).pipe(res);
    },
  ),
];
