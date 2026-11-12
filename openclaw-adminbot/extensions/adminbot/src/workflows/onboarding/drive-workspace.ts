// Provisions a member's Google Drive workspace by copying the lab's prototype folder.
//
// Drive cannot copy a folder -- `files.copy` on one returns 403 cannotCopyFile -- so this is
// mkdir, then a copy per child, then the share. A subfolder in the prototype is made again with
// `mkdir --parent` and its own children copied into it, recursively. The prototype was flat until
// it gained `yyyymmdd_ProjectName` (2026-11), and the flat-only copier then refused every
// full-member send; recursion is bounded by MAX_PROTOTYPE_DEPTH so a prototype that grows a deep
// tree still fails loudly rather than producing a workspace nobody checked.
//
// Verified against the live prototype before this shipped, including that shortcuts copy as
// shortcuts (keeping their targets) rather than duplicating what they point at.
import { resolveGogExecutable, runGogPaced } from "../../connectors/gog.js";

const GOG_TIMEOUT_MS = 120_000;
const GOG_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** The `Zhijing-StudentName` prototype, owned by the AdminBot account. */
export const DEFAULT_DRIVE_PROTOTYPE_FOLDER_ID = "1abl0CdA2Le3t2WxOy8Fb8UUMsmiQbAPs";

export type DriveWorkspace = { folderId: string; link: string };

export type DriveWorkspaceProvisioner = (params: {
  folderName: string;
  /**
   * Whether to copy the prototype's contents in, or hand over an empty folder.
   *
   * Only full members get the templates and worksheets: everyone else who receives a folder --
   * trial-phase students, co-authors, visiting professors -- gets somewhere to put their own files
   * and nothing of the lab's. The folder itself is still created and shared either way, because the
   * onboarding copy links to it regardless of who is reading.
   */
  includeContents: boolean;
}) => Promise<DriveWorkspace>;

type GogRun = (args: string[]) => Promise<string>;

type DriveChild = { id: string; name: string; mimeType?: string };

function readJson(stdout: string, what: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`gog ${what} did not return JSON`);
  }
}

function listPrototypeChildren(payload: Record<string, unknown>): DriveChild[] {
  const files = Array.isArray(payload.files) ? payload.files : [];
  return files.map((entry) => entry as DriveChild);
}

/** Folder levels under the prototype the copier will recreate: today's prototype has one. */
const MAX_PROTOTYPE_DEPTH = 3;

/**
 * A Drive query for folders of exactly this name owned by the account, with the name quoted the
 * way the Drive query language wants: backslash and single quote escaped, nothing else.
 */
export function driveWorkspaceLookupQuery(folderName: string): string {
  const quoted = folderName.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  return `name = '${quoted}' and mimeType = '${FOLDER_MIME}' and trashed = false and 'me' in owners`;
}

/**
 * Returns the person's Drive workspace: the existing folder of that name if there is one,
 * otherwise a new copy of the prototype. Either way it is link-editable and the link comes back.
 * Cleans up its own folder when a later step fails, so a failed send never leaves a half-built
 * workspace that looks provisioned.
 */
export function createDriveWorkspaceProvisioner(
  options: {
    env?: NodeJS.ProcessEnv;
    prototypeFolderId?: string;
    // Same seam as the gog action executor's `run`: lets tests assert the commands without
    // touching a real Drive.
    run?: GogRun;
  } = {},
): DriveWorkspaceProvisioner {
  const env = options.env ?? process.env;
  const prototypeFolderId = options.prototypeFolderId?.trim() || DEFAULT_DRIVE_PROTOTYPE_FOLDER_ID;
  const account = env.GOG_ACCOUNT?.trim();
  const gog = resolveGogExecutable(env);
  const run: GogRun =
    options.run ??
    (async (args) => {
      const { stdout } = await runGogPaced(gog, args, {
        env,
        maxBuffer: GOG_MAX_OUTPUT_BYTES,
        timeoutMs: GOG_TIMEOUT_MS,
      });
      return stdout;
    });
  const gogArgs = (...rest: string[]): string[] => [
    "--json",
    "--no-input",
    ...(account ? ["--account", account] : []),
    "drive",
    ...rest,
  ];

  return async ({ folderName, includeContents }) => {
    const name = folderName.trim();
    if (!name) {
      throw new Error("a folder name is required to provision a Drive workspace");
    }
    // One folder per person. The welcome is sent more than once -- a resend, or the catch-up mail
    // for members whose welcome never carried the link -- and every send used to mkdir a fresh
    // copy, so a member could end up with two folders and Zhijing reading the wrong one. A folder
    // of exactly this name owned by this account is that person's: it is shared again (the grant
    // is idempotent) and its link returned, and nothing is copied into it a second time.
    const existing = readJson(
      await run(gogArgs("ls", "--query", driveWorkspaceLookupQuery(name), "--max", "10")),
      "drive ls",
    );
    const found = (Array.isArray(existing.files) ? existing.files : []).find(
      (file): file is { id: string } =>
        Boolean(file) &&
        typeof file === "object" &&
        typeof (file as { id?: unknown }).id === "string" &&
        (file as { name?: unknown }).name === name &&
        ((file as { mimeType?: unknown }).mimeType ?? FOLDER_MIME) === FOLDER_MIME,
    );
    if (found) {
      const shared = readJson(
        await run(gogArgs("share", found.id, "--to", "anyone", "--role", "writer", "--force")),
        "drive share",
      );
      return {
        folderId: found.id,
        link:
          typeof shared.link === "string" && shared.link
            ? shared.link
            : `https://drive.google.com/drive/folders/${found.id}`,
      };
    }

    // Not read at all for an empty workspace: listing the prototype only exists to copy it, and a
    // prototype that has gone missing should not fail a send that was never going to touch it.
    // `--max 0` means "no limit" for `drive tree` but is rejected by `drive ls`, which is how a
    // half-built folder got left behind during development.
    const children = includeContents
      ? listPrototypeChildren(
          readJson(
            await run(gogArgs("ls", "--parent", prototypeFolderId, "--max", "1000")),
            "drive ls",
          ),
        )
      : [];
    if (includeContents && children.length === 0) {
      throw new Error("prototype folder is empty; refusing to provision an empty workspace");
    }

    // `drive mkdir` answers under `folder`, while `drive copy` answers under `file`.
    const created = readJson(await run(gogArgs("mkdir", name)), "drive mkdir");
    const folder = created.folder as { id?: string } | undefined;
    const folderId = folder?.id;
    if (!folderId) {
      throw new Error("gog drive mkdir did not return a folder id");
    }

    // A subfolder is made again inside the new workspace and its own children copied into it;
    // files and shortcuts are copied as before (shortcuts keep their targets).
    const copyChildren = async (
      entries: DriveChild[],
      parentId: string,
      depth: number,
    ): Promise<void> => {
      for (const child of entries) {
        if (!child.id || !child.name) {
          throw new Error("prototype child is missing an id or name");
        }
        if (child.mimeType !== FOLDER_MIME) {
          await run(gogArgs("copy", child.id, child.name, "--parent", parentId));
          continue;
        }
        if (depth >= MAX_PROTOTYPE_DEPTH) {
          throw new Error(
            `prototype folder nests deeper than ${MAX_PROTOTYPE_DEPTH} levels at "${child.name}"; refusing to copy it`,
          );
        }
        const made = readJson(
          await run(gogArgs("mkdir", child.name, "--parent", parentId)),
          "drive mkdir",
        );
        const subfolderId = (made.folder as { id?: string } | undefined)?.id;
        if (!subfolderId) {
          throw new Error("gog drive mkdir did not return a folder id");
        }
        const inner = listPrototypeChildren(
          readJson(await run(gogArgs("ls", "--parent", child.id, "--max", "1000")), "drive ls"),
        );
        await copyChildren(inner, subfolderId, depth + 1);
      }
    };

    try {
      await copyChildren(children, folderId, 0);
      // `--force` is required for an `anyone` grant non-interactively; without it gog refuses and
      // the folder would be created but never shared.
      const shared = readJson(
        await run(gogArgs("share", folderId, "--to", "anyone", "--role", "writer", "--force")),
        "drive share",
      );
      const link =
        typeof shared.link === "string" && shared.link
          ? shared.link
          : `https://drive.google.com/drive/folders/${folderId}`;
      return { folderId, link };
    } catch (error) {
      await run(gogArgs("delete", folderId, "--force")).catch(() => {
        // Best effort: the send has already failed, and a stray folder is better reported than
        // retried into a second failure.
      });
      throw error;
    }
  };
}
