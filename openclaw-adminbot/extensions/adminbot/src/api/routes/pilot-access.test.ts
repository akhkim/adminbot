import { describe, expect, it } from "vitest";
import { pilotOperation } from "./pilot-access.js";

describe("CLI pilot tokens", () => {
  it("keep a member token to their own records: no messaging other people, no paid model calls", () => {
    for (const [path, method] of [
      ["/events/say-hi", "POST"],
      ["/lab-sharing/invites", "POST"],
      ["/lab-sharing/ask", "POST"],
      ["/guidebook/ask", "POST"],
      ["/papers/linkedin-draft", "POST"],
      ["/papers/x-draft", "POST"],
      ["/profile-photo/polish", "POST"],
      ["/papermentor/reviews", "POST"],
      ["/venue-papers/search", "POST"],
      ["/reimbursements/submit", "POST"],
    ]) {
      expect(pilotOperation(path, method, false), `${method} ${path}`).toBeUndefined();
    }
  });

  it("still let a member read and edit their own work", () => {
    for (const [path, method] of [
      ["/lab-sharing/invites", "GET"],
      ["/papermentor/reviews", "GET"],
      ["/papers/p1/weekly-updates", "POST"],
      ["/lab/members/roster", "GET"],
    ]) {
      expect(pilotOperation(path, method, false), `${method} ${path}`).toBeDefined();
    }
  });
});
