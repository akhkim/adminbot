import { describe, expect, it, vi } from "vitest";
import { lookupSlackEmails } from "../../scripts/adminbot-slack-email-lookup.js";

describe("Slack email linking", () => {
  it("reads every workspace page, excludes inactive/bot/ambiguous accounts and returns only requested matches", async () => {
    const apiCall = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        members: [
          { id: "U123", profile: { email: "Wanted@Example.com" } },
          { id: "U234", profile: { email: "duplicate@example.com" } },
          { id: "U345", deleted: true, profile: { email: "deleted@example.com" } },
          { id: "U456", is_bot: true, profile: { email: "bot@example.com" } },
          { id: "U567", profile: { email: "other@example.com" } },
        ],
        response_metadata: { next_cursor: "second" },
      })
      .mockResolvedValueOnce({
        ok: true,
        members: [
          { id: "U678", profile: { email: "duplicate@example.com" } },
          { id: "W789", profile: { email: "last@example.com" } },
        ],
      });
    const result = await lookupSlackEmails({ apiCall }, [
      " wanted@example.com ",
      "duplicate@example.com",
      "deleted@example.com",
      "bot@example.com",
      "last@example.com",
    ]);
    expect(result).toEqual([
      { id: "U123", raw: { profile: { email: "wanted@example.com" } } },
      { id: "W789", raw: { profile: { email: "last@example.com" } } },
    ]);
    expect(apiCall).toHaveBeenLastCalledWith("users.list", { limit: 200, cursor: "second" });
  });
  it("reports missing permission instead of returning a successful empty lookup", async () => {
    await expect(
      lookupSlackEmails({ apiCall: async () => ({ ok: false, error: "missing_scope" }) }, [
        "a@example.com",
      ]),
    ).rejects.toThrow("missing_scope");
  });
  it("does not loop indefinitely on a repeated cursor", async () => {
    await expect(
      lookupSlackEmails(
        {
          apiCall: async () => ({
            ok: true,
            members: [],
            response_metadata: { next_cursor: "same" },
          }),
        },
        ["a@example.com"],
      ),
    ).rejects.toThrow("repeated cursor");
  });
  it("reports email visibility failure instead of silently leaving everybody unlinked", async () => {
    await expect(
      lookupSlackEmails(
        { apiCall: async () => ({ ok: true, members: [{ id: "U123", profile: {} }] }) },
        ["a@example.com"],
      ),
    ).rejects.toThrow("email addresses are unavailable");
  });
  it("does not request the directory for an empty roster", async () => {
    const apiCall = vi.fn();
    expect(await lookupSlackEmails({ apiCall }, [])).toEqual([]);
    expect(apiCall).not.toHaveBeenCalled();
  });
});
