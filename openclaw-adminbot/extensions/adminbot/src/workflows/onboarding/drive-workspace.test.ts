import { describe, expect, it, vi } from "vitest";
import { createDriveWorkspaceProvisioner } from "./drive-workspace.js";

const PROTOTYPE = "proto-folder";

// One canned answer per gog subcommand, so a test only has to say what Drive contains.
function runnerFor(children: Array<{ id: string; name: string; mimeType?: string }>) {
  return vi.fn(async (args: string[]) => {
    const command = args[args.indexOf("drive") + 1];
    if (command === "ls") {
      return JSON.stringify({ files: children });
    }
    if (command === "mkdir") {
      return JSON.stringify({ folder: { id: "new-folder" } });
    }
    if (command === "share") {
      return JSON.stringify({ link: "https://drive.example/new-folder" });
    }
    return "{}";
  });
}

function commandsIn(run: ReturnType<typeof runnerFor>): string[] {
  return run.mock.calls.map((call) => {
    const args = call[0];
    return args[args.indexOf("drive") + 1] ?? "";
  });
}

const CHILDREN = [
  { id: "c1", name: "Reading list" },
  { id: "c2", name: "Progress log" },
];

describe("createDriveWorkspaceProvisioner", () => {
  it("copies every prototype child in when contents are wanted", async () => {
    const run = runnerFor(CHILDREN);
    const provision = createDriveWorkspaceProvisioner({ prototypeFolderId: PROTOTYPE, run });

    const workspace = await provision({ folderName: "Zhijing-Ada", includeContents: true });

    expect(workspace).toEqual({
      folderId: "new-folder",
      link: "https://drive.example/new-folder",
    });
    expect(commandsIn(run).filter((command) => command === "copy")).toHaveLength(2);
  });

  // The folder still has to exist and be shared: the onboarding email links to it either way, and
  // an unshared folder reads to the recipient as a broken link rather than as an empty workspace.
  it("creates and shares an empty folder when contents are withheld", async () => {
    const run = runnerFor(CHILDREN);
    const provision = createDriveWorkspaceProvisioner({ prototypeFolderId: PROTOTYPE, run });

    const workspace = await provision({ folderName: "Zhijing-Ada", includeContents: false });

    expect(workspace.folderId).toBe("new-folder");
    const commands = commandsIn(run);
    expect(commands).toContain("mkdir");
    expect(commands).toContain("share");
    expect(commands).not.toContain("copy");
  });

  // Listing the prototype exists only to copy it. A send that was never going to touch it should
  // not fail because the prototype moved, nor spend a Drive call finding that out.
  it("never reads the prototype at all when contents are withheld", async () => {
    const run = runnerFor(CHILDREN);
    const provision = createDriveWorkspaceProvisioner({ prototypeFolderId: PROTOTYPE, run });

    await provision({ folderName: "Zhijing-Ada", includeContents: false });

    expect(commandsIn(run)).not.toContain("ls");
  });

  it("still refuses to copy from an empty prototype", async () => {
    const run = runnerFor([]);
    const provision = createDriveWorkspaceProvisioner({ prototypeFolderId: PROTOTYPE, run });

    await expect(provision({ folderName: "Zhijing-Ada", includeContents: true })).rejects.toThrow(
      /prototype folder is empty/u,
    );
  });

  // An empty prototype says nothing about a workspace that was never going to receive its
  // contents, so the same folder that fails above must succeed here.
  it("provisions an empty workspace even when the prototype is empty", async () => {
    const run = runnerFor([]);
    const provision = createDriveWorkspaceProvisioner({ prototypeFolderId: PROTOTYPE, run });

    await expect(
      provision({ folderName: "Zhijing-Ada", includeContents: false }),
    ).resolves.toMatchObject({ folderId: "new-folder" });
  });

  it("deletes the folder it made when a copy fails", async () => {
    const run = vi.fn(async (args: string[]) => {
      const command = args[args.indexOf("drive") + 1];
      if (command === "ls") {
        return JSON.stringify({ files: CHILDREN });
      }
      if (command === "mkdir") {
        return JSON.stringify({ folder: { id: "new-folder" } });
      }
      if (command === "copy") {
        throw new Error("drive copy exploded");
      }
      return "{}";
    });
    const provision = createDriveWorkspaceProvisioner({ prototypeFolderId: PROTOTYPE, run });

    await expect(provision({ folderName: "Zhijing-Ada", includeContents: true })).rejects.toThrow(
      /drive copy exploded/u,
    );
    expect(run.mock.calls.some((call) => call[0][call[0].indexOf("drive") + 1] === "delete")).toBe(
      true,
    );
  });
});
