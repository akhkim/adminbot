import { createHash } from "node:crypto";
import { composeOnboardingGuide } from "../../workflows/onboarding/guide.js";
import { memberTypeTokens } from "../../workflows/onboarding/member-type-template.js";
import { readJsonOrEmpty, sendJson } from "../server.http.js";
import { adminSessionOnly } from "./guards.js";
import { post, type Route } from "./router.js";

export const acquaintanceWelcomeRoutes: readonly Route[] = [
  post(
    /^\/lab\/members\/([^/]+)\/onboarding\/welcome\/(preview|queue)$/u,
    adminSessionOnly(async ({ req, res, ctx, principal, params }) => {
      if (principal.kind !== "member") {
        return;
      }
      const member = ctx.store.getLabMember(decodeURIComponent(params[1]));
      if (!member) {
        sendJson(res, 404, { error: { message: "Member not found." } });
        return;
      }
      if (!memberTypeTokens(member.member_type).includes("acquaintance")) {
        sendJson(res, 422, { error: { message: "Use the role-specific guide for this member." } });
        return;
      }
      const body = (await readJsonOrEmpty(req)) as Record<string, unknown>;
      if (
        !body ||
        typeof body !== "object" ||
        (body.subject !== undefined &&
          (typeof body.subject !== "string" ||
            !body.subject.trim() ||
            body.subject.length > 200 ||
            /[\r\n]/u.test(body.subject))) ||
        (body.body !== undefined &&
          (typeof body.body !== "string" || !body.body.trim() || body.body.length > 20000))
      ) {
        sendJson(res, 400, {
          error: {
            message:
              "Use a subject of up to 200 characters and a nonempty body of up to 20,000 characters.",
          },
        });
        return;
      }
      if (
        Object.keys(body).some(
          (key) => !["subject", "body", "preview_hash", "resend"].includes(key),
        ) ||
        (body.resend !== undefined && typeof body.resend !== "boolean")
      ) {
        sendJson(res, 400, {
          error: {
            message:
              "The recipient comes from the correspondence email on the member record. Only subject, body and an explicit resend choice may be edited.",
          },
        });
        return;
      }
      const email = member.email?.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
        sendJson(res, 422, {
          error: {
            message:
              "Set a valid correspondence email on the member record first. The Slack invite address is separate.",
          },
        });
        return;
      }
      const copy = composeOnboardingGuide(
        "welcome",
        { first_name: member.name.trim().split(/\s+/u)[0], name: member.name, email },
        process.env,
        {
          ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
          ...(typeof body.body === "string" ? { body: body.body } : {}),
        },
      );
      if (!copy.ok) {
        sendJson(res, 422, {
          error: {
            message: `Welcome preview is unavailable: ${copy.reason}.`,
            missing: copy.missing,
          },
        });
        return;
      }
      if (/\{[a-z_]+\}/u.test(copy.guide.subject + copy.guide.body)) {
        sendJson(res, 422, {
          error: { message: "Replace unresolved placeholders before preparing this welcome." },
        });
        return;
      }
      const preview = {
        member_id: member.id,
        resend: body.resend === true,
        email,
        subject: copy.guide.subject,
        body: copy.guide.body,
      };
      const previewHash = createHash("sha256").update(JSON.stringify(preview)).digest("hex");
      if (params[2] === "preview") {
        sendJson(res, 200, { ...preview, preview_hash: previewHash });
        return;
      }
      if (body.preview_hash !== previewHash) {
        sendJson(res, 409, {
          error: { message: "The recipient or copy changed. Preview again before queueing." },
        });
        return;
      }
      const result = ctx.service.queueOnboardingGuideForMember({
        memberId: member.id,
        actor: principal.member.id,
        basicWelcome: true,
        resend: body.resend === true,
        subjectOverride: preview.subject,
        bodyOverride: preview.body,
      });
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      sendJson(res, 200, {
        ...result.payload,
        status: "pending",
        detail: "Queued for a separate exact-payload approval. No email or invitation was sent.",
      });
    }),
  ),
];
