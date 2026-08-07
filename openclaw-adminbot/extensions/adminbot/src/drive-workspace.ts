// Provisions a member's Google Drive workspace by copying the lab's prototype folder.
//
// Drive cannot copy a folder -- `files.copy` on one returns 403 cannotCopyFile -- so this is
// mkdir, then a copy per child, then the share. The prototype is flat (six items, no subfolders),
// so there is no recursion here on purpose: adding it would be untested code for a shape the
// prototype does not have. If the prototype ever grows a subfolder, `listPrototypeChildren`
// reports it and provisioning fails loudly rather than silently producing a partial workspace.
//
// Verified against the live prototype before this shipped, including that shortcuts copy as
// shortcuts (keeping their targets) rather than duplicating what they point at.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolveGogExecutable } from "./gog-executor.js";

const execFile = promisify(execFileCallback);
const GOG_TIMEOUT_MS = 120_000;
const GOG_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** The `Zhijing-StudentName` prototype, owned by the AdminBot account. */
export const DEFAULT_DRIVE_PROTOTYPE_FOLDER_ID = "1abl0CdA2Le3t2WxOy8Fb8UUMsmiQbAPs";

export type DriveWorkspace = { folderId: string; link: string };

export type DriveWorkspaceProvisioner = (params: { folderName: string }) => Promise<DriveWorkspace>;

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
  const children = files.map((entry) => entry as DriveChild);
  const nested = children.filter((child) => child.mimeType === FOLDER_MIME);
  if (nested.length > 0) {
    // Copying this correctly needs recursion, which the flat prototype never exercised. Fail
    // rather than hand someone a workspace that silently lost a folder.
    throw new Error(
      `prototype folder now contains subfolders (${nested
        .map((child) => child.name)
        .join(", ")}); the copier only handles a flat prototype`,
    );
  }
  return children;
}

/**
 * Copies the prototype into a new folder named `folderName`, makes it link-editable, and returns
 * the link. Cleans up its own folder when a later step fails, so a failed send never leaves a
 * half-built workspace that looks provisioned.
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
      const { stdout } = await execFile(gog, args, {
        env,
        maxBuffer: GOG_MAX_OUTPUT_BYTES,
        timeout: GOG_TIMEOUT_MS,
        windowsHide: true,
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

  return async ({ folderName }) => {
    const name = folderName.trim();
    if (!name) {
      throw new Error("a folder name is required to provision a Drive workspace");
    }
    // `--max 0` means "no limit" for `drive tree` but is rejected by `drive ls`, which is how a
    // half-built folder got left behind during development.
    const children = listPrototypeChildren(
      readJson(
        await run(gogArgs("ls", "--parent", prototypeFolderId, "--max", "1000")),
        "drive ls",
      ),
    );
    if (children.length === 0) {
      throw new Error("prototype folder is empty; refusing to provision an empty workspace");
    }

    // `drive mkdir` answers under `folder`, while `drive copy` answers under `file`.
    const created = readJson(await run(gogArgs("mkdir", name)), "drive mkdir");
    const folder = created.folder as { id?: string } | undefined;
    const folderId = folder?.id;
    if (!folderId) {
      throw new Error("gog drive mkdir did not return a folder id");
    }

    try {
      for (const child of children) {
        if (!child.id || !child.name) {
          throw new Error("prototype child is missing an id or name");
        }
        await run(gogArgs("copy", child.id, child.name, "--parent", folderId));
      }
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
