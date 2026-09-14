// Which link names which file, and what is refused.
import { describe, expect, it } from "vitest";
import { adminBotDriveFileId } from "./drive-links.js";

const ID = "1PdF9xAbCdEfGhIjKlMnOpQrStUv";

describe("adminBotDriveFileId", () => {
  it("reads every share form the lab actually pastes", () => {
    for (const url of [
      `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
      `https://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
      `https://docs.google.com/presentation/d/${ID}`,
      `https://drive.google.com/drive/folders/${ID}`,
      `https://drive.google.com/open?id=${ID}`,
    ]) {
      expect(adminBotDriveFileId(url)).toBe(ID);
    }
  });

  it("refuses anything that is not a Google link naming a file", () => {
    for (const url of [
      `https://evil.example/file/d/${ID}/view`,
      `http://drive.google.com/file/d/${ID}/view`,
      "https://drive.google.com/drive/my-drive",
      "https://docs.google.com/document/d/short/edit",
      "not a url",
      "",
    ]) {
      expect(adminBotDriveFileId(url)).toBeUndefined();
    }
  });

  it("keeps the id a closed charset, since it becomes an argument to a connector", () => {
    expect(adminBotDriveFileId("https://drive.google.com/file/d/../../etc/passwd")).toBeUndefined();
    expect(adminBotDriveFileId(`https://drive.google.com/open?id=${ID}/../x`)).toBeUndefined();
  });
});
