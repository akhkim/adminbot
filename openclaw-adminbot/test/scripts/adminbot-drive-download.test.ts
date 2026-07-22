import { describe, expect, it } from "vitest";
import { driveFileIds } from "../../scripts/adminbot-drive-download.js";

describe("AdminBot reimbursement Drive links", () => {
  it("extracts unique Drive and Google document file IDs", () => {
    expect(
      driveFileIds(
        [
          "https://drive.google.com/file/d/file_123/view",
          "https://docs.google.com/document/d/doc-456/edit",
          "https://drive.google.com/open?id=sheet_789",
          "https://drive.google.com/file/d/file_123/view",
        ].join("\n"),
      ),
    ).toEqual(["file_123", "doc-456", "sheet_789"]);
  });
});
