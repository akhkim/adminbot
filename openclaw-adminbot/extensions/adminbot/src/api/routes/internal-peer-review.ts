import { paperInvolvesMember } from "../../contracts/paper-involvement.js";
import {
  internalReviewerSuggestions,
  nomineeBlockReason,
  parsePeerReviewDraft,
} from "../../workflows/papers/internal-peer-review.js";
import { readJsonOrEmpty, sendJson } from "../server.http.js";
import { memberOnly } from "./guards.js";
import { route, type Route } from "./router.js";

export const internalPeerReviewRoutes: readonly Route[] = [
  route(
    ["GET", "PUT"],
    /^\/papers\/([^/]+)\/internal-peer-review$/u,
    memberOnly(async ({ req, res, params, principal, ctx }) => {
      const id = decodeURIComponent(params[1]);
      const paper = ctx.store.getPaper(id);
      if (
        !paper ||
        (principal.member.privilege_level !== "admin" &&
          !paperInvolvesMember(paper, principal.member.id, principal.member.name))
      ) {
        sendJson(res, 404, { error: { message: "Paper not found." } });
        return;
      }
      // Each author keeps their own working copy. Admin status never reads another author's draft.
      const key = `internal-peer-review:${id}`;
      if (req.method === "GET") {
        sendJson(res, 200, {
          draft: ctx.memberDrafts.read(principal.member.id, key),
          suggestions: internalReviewerSuggestions(ctx.store.listLabMembers(), paper),
        });
        return;
      }
      const body = (await readJsonOrEmpty(req)) as Record<string, unknown>;
      const draft = parsePeerReviewDraft(body?.data);
      if (
        !draft ||
        !Number.isSafeInteger(body.revision) ||
        Number(body.revision) < 0 ||
        typeof body.mutation_id !== "string" ||
        !body.mutation_id.trim() ||
        body.mutation_id.length > 100 ||
        Object.keys(body).some((field) => !["data", "revision", "mutation_id"].includes(field))
      ) {
        sendJson(res, 400, {
          error: {
            message:
              "Use a bounded purpose, optional HTTPS draft link, up to ten nominee IDs and current revision.",
          },
        });
        return;
      }
      if (
        draft.nominee_ids.some((nomineeId) => {
          const member = ctx.store.getLabMember(nomineeId);
          return !member || nomineeBlockReason(member, paper);
        })
      ) {
        sendJson(res, 422, {
          error: {
            message:
              "A nominee is missing, exempt or involved in the paper. Refresh the candidates.",
          },
        });
        return;
      }
      const saved = ctx.memberDrafts.write(
        principal.member.id,
        key,
        Number(body.revision),
        body.mutation_id,
        draft,
      );
      if (!saved) {
        sendJson(res, 409, {
          error: { message: "Draft changed. Load the saved copy before editing again." },
        });
        return;
      }
      sendJson(res, 200, {
        draft: saved,
        detail:
          "Private draft saved. No invitation sent, assignment accepted or document access granted.",
      });
    }),
  ),
];
