import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDriveFileBase64, resolveGogExecutable } from "../connectors/gog.js";
import { adminBotNormalizeXHandle, type AdminBotLabMember } from "../contracts/actions.js";
import { readJson, sendJson } from "./server.http.js";

const DEFAULT_NOTIFICATIONS_FILE_ID = "1M88hLvN6WvWIthUPTnHilWbsmOz2DZg7";

export function createNotificationDraftHandler(
  scriptPath?: string,
  listMembers: () => AdminBotLabMember[] = () => [],
  listPaperLinks: () => { title: string; submission_url?: string; arxiv_url?: string }[] = () => [],
) {
  let busy = false;
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    if (!scriptPath) {
      sendJson(res, 503, {
        error: { message: "Notification draft generation is not configured." },
      });
      return;
    }
    if (busy) {
      sendJson(res, 429, {
        error: { message: "Another draft is being generated. Try again shortly." },
      });
      return;
    }
    busy = true;
    let directory: string | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on("close", abort);
    const timeout = setTimeout(() => {
      controller.abort();
      req.destroy();
    }, 30_000);
    try {
      const body = (await readJson(req, 26 * 1024 * 1024)) as Record<string, unknown>;
      if (
        !body ||
        !(
          (body.notifications === undefined && body.notifications_csv === undefined) ||
          (Array.isArray(body.notifications) &&
            body.notifications.length <= 10000 &&
            body.notifications_csv === undefined) ||
          (typeof body.notifications_csv === "string" &&
            body.notifications_csv.trim().length > 0 &&
            body.notifications === undefined)
        ) ||
        typeof body.min_date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(body.min_date) ||
        typeof body.conference !== "string" ||
        !/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(body.conference) ||
        (body.template != null &&
          (!Number.isInteger(body.template) ||
            Number(body.template) < 1 ||
            Number(body.template) > 10)) ||
        (body.images !== undefined && typeof body.images !== "boolean")
      ) {
        sendJson(res, 400, {
          error: {
            message:
              "Provide notifications, a cutoff date, a conference, and a template from 1 to 10 (or random).",
          },
        });
        return;
      }
      clearTimeout(timeout);
      if (body.notifications === undefined && body.notifications_csv === undefined) {
        try {
          const encoded = await readDriveFileBase64(DEFAULT_NOTIFICATIONS_FILE_ID, {
            command: resolveGogExecutable(),
            maxBytes: 25 * 1024 * 1024,
            signal: controller.signal,
          });
          body.notifications_csv = Buffer.from(encoded, "base64").toString("utf8");
          if (!(body.notifications_csv as string).trim()) {
            throw new Error("Empty CSV");
          }
        } catch {
          sendJson(res, 502, {
            error: {
              message:
                "Could not load the default Google Drive CSV (maximum 25 MB). Check the service's gog sign-in and access to the shared file, or upload a CSV/JSON file.",
            },
          });
          return;
        }
      }
      const members = listMembers().map((member) => ({
        openreview_id: member.openreview_id,
        handle: adminBotNormalizeXHandle(member.twitter_url),
      }));
      directory = await mkdtemp(path.join(tmpdir(), "adminbot-notification-drafts-"));
      const output = await new Promise<string>((resolve, reject) => {
        // Uploaded contents stay on stdin, never in shell arguments or logs.
        const child = spawn(
          process.env.ADMINBOT_NOTIFICATIONS_PYTHON || "python3",
          [scriptPath, directory!],
          {
            stdio: ["pipe", "pipe", "pipe"],
            signal: controller.signal,
            timeout: 180_000,
            killSignal: "SIGKILL",
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
          },
        );
        let stdout = "";
        let overflow = false;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (overflow) {
            return;
          }
          stdout += chunk;
          if (Buffer.byteLength(stdout) > 12 * 1024 * 1024) {
            overflow = true;
            child.kill("SIGKILL");
          }
        });
        child.stderr.resume();
        child.stdin.on("error", () => {});
        let processError: Error | undefined;
        child.on("error", (error) => {
          processError = error;
        });
        child.on("close", (code) => {
          if (!processError && !overflow && (code === 0 || code === 1) && stdout.trim()) {
            resolve(stdout);
          } else {
            reject(new Error("Generation failed"));
          }
        });
        child.stdin.end(
          JSON.stringify({
            notifications: body.notifications,
            notifications_csv: body.notifications_csv,
            min_date: body.min_date,
            conference: body.conference,
            template: body.template,
            images: body.images,
            // The roster comes only from the service store, never the browser.
            members,
            paper_links: listPaperLinks(),
          }),
        );
      });
      const result = JSON.parse(output) as { error?: string };
      sendJson(
        res,
        result.error ? 422 : 200,
        result.error ? { error: { message: result.error } } : result,
      );
    } catch {
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 400, {
          error: {
            message:
              "Could not generate drafts. Check the JSON file (maximum 25 MB) and that Python 3.10+ is configured. For images, install Pillow in that Python environment.",
          },
        });
      }
    } finally {
      clearTimeout(timeout);
      res.off("close", abort);
      // Generation has finished; independent temporary-directory cleanup must not block retries.
      busy = false;
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
}
