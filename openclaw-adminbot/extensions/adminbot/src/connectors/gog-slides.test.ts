import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createGogDriveFaceHost, createGogSlidesClient, PRESENTATION_FIELDS } from "./gog-slides.js";

const ACCOUNT = "bot@example.com";

/** Returns the flags that follow `name` in a gog argv. */
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

describe("createGogSlidesClient", () => {
  it("reads the presentation through gog api call, pinned to that one method", async () => {
    const capture = vi.fn(async (_args: string[]) => JSON.stringify({ presentationId: "p1", slides: [] }));
    const client = createGogSlidesClient({ account: ACCOUNT, capture });
    expect(await client.getPresentation("p1")).toEqual({ presentationId: "p1", slides: [] });
    const args = capture.mock.calls[0]![0] as string[];
    expect(args.slice(0, 6)).toEqual([
      "--json",
      "--no-input",
      "--enable-commands-exact",
      "api.call,api.slides.presentations.get",
      "--account",
      ACCOUNT,
    ]);
    expect(args).not.toContain("--allow-write");
    expect(args).toEqual(expect.arrayContaining(["api", "call", "slides", "v1", "slides.presentations.get"]));
    expect(JSON.parse(flag(args, "--params")!)).toEqual({ presentationId: "p1", fields: PRESENTATION_FIELDS });
    expect(flag(args, "--scope")).toBe("https://www.googleapis.com/auth/drive");
  });

  it("sends the batch update from a scratch file with writes opted in, then removes the file", async () => {
    let body: unknown;
    let bodyPath = "";
    const capture = vi.fn(async (args: string[]) => {
      bodyPath = flag(args, "--body")!.slice(1);
      body = JSON.parse(fs.readFileSync(bodyPath, "utf8"));
      return "{}";
    });
    const client = createGogSlidesClient({ account: ACCOUNT, capture, scope: "https://www.googleapis.com/auth/presentations" });
    const requests = [{ deleteObject: { objectId: "adminbot_face_interp_0123456789ab" } }];
    await client.batchUpdate("p1", requests);
    const args = capture.mock.calls[0]![0] as string[];
    expect(args[3]).toBe("api.call,api.slides.presentations.batchupdate");
    expect(args).toEqual(expect.arrayContaining(["--force", "--allow-write", "slides.presentations.batchUpdate"]));
    expect(flag(args, "--scope")).toBe("https://www.googleapis.com/auth/presentations");
    expect(body).toEqual({ requests });
    expect(fs.existsSync(bodyPath)).toBe(false);
  });

  it("says which command failed when gog prints something that is not JSON", async () => {
    const client = createGogSlidesClient({ account: ACCOUNT, capture: async () => "Error: not authorised" });
    await expect(client.getPresentation("p1")).rejects.toThrow(/non-JSON output for presentations.get/u);
  });
});

describe("createGogDriveFaceHost", () => {
  it("uploads into the face folder, shares by link only until released, then unshares", async () => {
    const calls: string[][] = [];
    const capture = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args.includes("upload")) {
        expect(fs.readFileSync(args[args.indexOf("upload") + 1]!, "utf8")).toBe("png-bytes");
        return JSON.stringify({ file: { id: "file_1" } });
      }
      if (args.includes("share")) {
        return JSON.stringify({ link: "https://drive.example/file_1", permissionId: "anyoneWithLink" });
      }
      return "{}";
    });
    const host = createGogDriveFaceHost({ account: ACCOUNT, capture, folderId: "folder_9" });
    const published = await host.publish(Buffer.from("png-bytes"), "adminbot_face_x.png");
    expect(published.url).toBe("https://drive.google.com/uc?export=download&id=file_1");
    expect(calls[0]![3]).toBe("drive.upload");
    expect(flag(calls[0]!, "--parent")).toBe("folder_9");
    expect(flag(calls[0]!, "--mime-type")).toBe("image/png");
    expect(calls[1]![3]).toBe("drive.share");
    expect(flag(calls[1]!, "--to")).toBe("anyone");
    expect(flag(calls[1]!, "--role")).toBe("reader");
    await published.release();
    expect(calls[2]!.slice(-4)).toEqual(["drive", "unshare", "file_1", "anyoneWithLink"]);
    expect(calls[2]![3]).toBe("drive.unshare");
  });

  it("does not share a file whose upload returned no id", async () => {
    const capture = vi.fn(async (_args: string[]) => "{}");
    const host = createGogDriveFaceHost({ account: ACCOUNT, capture, folderId: "folder_9" });
    await expect(host.publish(Buffer.from("x"), "x.png")).rejects.toThrow(/no file id/u);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("needs a folder", () => {
    expect(() => createGogDriveFaceHost({ account: ACCOUNT, capture: vi.fn(), folderId: " " })).toThrow(/folder/u);
  });
});
