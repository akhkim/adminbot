// The working-groups slide over the gog CLI, as the same Google account every other AdminBot
// Google action uses (GOG_ACCOUNT). Slides has no first-class gog command for what this needs, so
// it goes through `gog api call`, which runs any Discovery-described method with the account's
// stored OAuth token. Each call is pinned with --enable-commands-exact to the one method it makes,
// so a malformed argument can never turn into a different Google call.

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GoogleSlidesClient, SlidesPresentation } from "../contracts/google-slides.js";
import { resolveGogExecutable } from "./gog.js";

const execFile = promisify(execFileCallback);
const GOG_TIMEOUT_MS = 120_000;
// A whole deck's page elements, even trimmed by `fields`, can run to several megabytes.
const GOG_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
// Only what the measurement reads; the full presentation can run to megabytes of text styling.
export const PRESENTATION_FIELDS = "presentationId,revisionId,pageSize,slides(objectId,pageElements)";
// Drive rather than the narrower presentations scope because it is the one the AdminBot account
// already granted gog for Drive work; ADMINBOT_SLIDES_GOG_SCOPE overrides it.
const DEFAULT_SCOPE = "https://www.googleapis.com/auth/drive";

export type GogCapture = (args: string[]) => Promise<string>;

export function createGogSlidesCapture(env: NodeJS.ProcessEnv = process.env): GogCapture {
  const executable = resolveGogExecutable(env);
  return async (args) => {
    try {
      const result = await execFile(executable, args, {
        env,
        maxBuffer: GOG_MAX_OUTPUT_BYTES,
        timeout: GOG_TIMEOUT_MS,
        windowsHide: true,
      });
      return result.stdout;
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: unknown };
      const detail =
        failure?.code === "ENOENT"
          ? "gog executable was not found in the AdminBot service PATH"
          : typeof failure?.stderr === "string" && failure.stderr.trim()
            ? failure.stderr.trim().split("\n")[0]!
            : error instanceof Error
              ? error.message
              : String(error);
      // args[3] is the --enable-commands-exact value, i.e. which command this was.
      throw new Error(`gog ${args[3] ?? ""} failed: ${detail}`, { cause: error });
    }
  };
}

type GogOptions = { account: string; scope?: string };

/** Root flags: JSON output, no prompts, and only the named command(s) enabled. */
function rootArgs(enabled: string[], account: string, force = false): string[] {
  const args = ["--json", "--no-input", "--enable-commands-exact", enabled.join(","), "--account", account];
  if (force) {
    args.push("--force");
  }
  return args;
}

function parseJson<T>(output: string, what: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(`gog returned non-JSON output for ${what}`);
  }
}

async function withScratchFile<T>(contents: string, use: (filePath: string) => Promise<T>): Promise<T> {
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adminbot-slides-"));
  try {
    const filePath = path.join(scratch, "body.json");
    await fs.promises.writeFile(filePath, contents, { encoding: "utf8", mode: 0o600 });
    return await use(filePath);
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
}

export function createGogSlidesClient(options: GogOptions & { capture: GogCapture }): GoogleSlidesClient {
  const scope = options.scope ?? DEFAULT_SCOPE;
  return {
    async getPresentation(presentationId) {
      const args = rootArgs(["api.call", "api.slides.presentations.get"], options.account);
      args.push(
        "api",
        "call",
        "slides",
        "v1",
        "slides.presentations.get",
        "--params",
        JSON.stringify({ presentationId, fields: PRESENTATION_FIELDS }),
        "--scope",
        scope,
      );
      return parseJson<SlidesPresentation>(await options.capture(args), "presentations.get");
    },
    async batchUpdate(presentationId, requests) {
      // The body goes through a file: a batch of 30 faces is well past what belongs on argv, where
      // it would also show up in every process listing.
      return withScratchFile(JSON.stringify({ requests }), async (filePath) => {
        const args = rootArgs(["api.call", "api.slides.presentations.batchupdate"], options.account, true);
        args.push(
          "api",
          "call",
          "slides",
          "v1",
          "slides.presentations.batchUpdate",
          "--params",
          JSON.stringify({ presentationId }),
          "--body",
          `@${filePath}`,
          "--allow-write",
          "--scope",
          scope,
        );
        return parseJson<unknown>(await options.capture(args), "presentations.batchUpdate");
      });
    },
  };
}

/** A face PNG somewhere Slides can fetch it, and how to take that access away again. */
export type PublishedFace = { url: string; release(): Promise<void> };
export type FaceHost = { publish(png: Buffer, name: string): Promise<PublishedFace> };

/**
 * Hosts rendered faces in one Drive folder of the AdminBot account.
 *
 * Slides' createImage fetches the URL anonymously from Google's side, so a private Drive file is
 * unreadable to it. Each file is therefore shared "anyone with the link, reader" just for the
 * batchUpdate and unshared straight after; Slides keeps its own copy of the pixels, so the files
 * can stay private in the folder afterwards. The link carries an unguessable file id and is never
 * published anywhere.
 */
export function createGogDriveFaceHost(
  options: GogOptions & { capture: GogCapture; folderId: string },
): FaceHost {
  const folderId = options.folderId.trim();
  if (!folderId) {
    throw new Error("a Drive folder id is required to host face images");
  }
  return {
    async publish(png, name) {
      const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adminbot-face-"));
      let fileId: string;
      try {
        const filePath = path.join(scratch, "face.png");
        await fs.promises.writeFile(filePath, png, { mode: 0o600 });
        const upload = rootArgs(["drive.upload"], options.account);
        upload.push("drive", "upload", filePath, "--parent", folderId, "--name", name, "--mime-type", "image/png");
        const uploaded = parseJson<{ file?: { id?: string } }>(await options.capture(upload), "drive upload");
        if (!uploaded.file?.id) {
          throw new Error("gog drive upload returned no file id");
        }
        fileId = uploaded.file.id;
      } finally {
        await fs.promises.rm(scratch, { recursive: true, force: true });
      }
      const share = rootArgs(["drive.share"], options.account, true);
      share.push("drive", "share", fileId, "--to", "anyone", "--role", "reader");
      const shared = parseJson<{ permissionId?: string }>(await options.capture(share), "drive share");
      const permissionId = shared.permissionId;
      return {
        url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`,
        async release() {
          if (!permissionId) {
            throw new Error(`gog drive share returned no permission id for ${fileId}; unshare it by hand`);
          }
          const unshare = rootArgs(["drive.unshare"], options.account, true);
          unshare.push("drive", "unshare", fileId, permissionId);
          await options.capture(unshare);
        },
      };
    },
  };
}
