// The partner desks the recurring roster and paper reports are mailed to.
//
// Every one of these recipients is outside the lab, so the thing worth testing is not that a good
// address round-trips but that an absent one stays absent: a report that guesses a desk sends
// other people's names and emails somewhere nobody chose.
import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

describe("partner recipient settings", () => {
  it("keeps each desk it is given", () => {
    const service = new AdminBotService();
    const saved = unwrap(
      service.updateSettings({
        dcs_server_access_email: "eugenia@cs.toronto.edu",
        vector_roster_email: "daniel.oltianu@vectorinstitute.ai",
        papers_submission_report_email: "kateryna.kononenko@tuebingen.mpg.de",
        papers_acceptance_mpi_emails: [
          "karin.bierig@tuebingen.mpg.de",
          "kateryna.kononenko@tuebingen.mpg.de",
        ],
        papers_acceptance_dcs_email: "eugenia@cs.toronto.edu",
        papers_acceptance_vector_email: "daniel.oltianu@vectorinstitute.ai",
        papers_acceptance_sri_email: "sri.research@utoronto.ca",
      }),
    );
    expect(saved.dcs_server_access_email).toBe("eugenia@cs.toronto.edu");
    expect(saved.vector_roster_email).toBe("daniel.oltianu@vectorinstitute.ai");
    expect(saved.papers_submission_report_email).toBe("kateryna.kononenko@tuebingen.mpg.de");
    // MPI is one desk read by two people, so it is one mail with both on it.
    expect(saved.papers_acceptance_mpi_emails).toEqual([
      "karin.bierig@tuebingen.mpg.de",
      "kateryna.kononenko@tuebingen.mpg.de",
    ]);
    expect(saved.papers_acceptance_sri_email).toBe("sri.research@utoronto.ca");
  });

  it("leaves a desk nobody configured unset, rather than defaulting it", () => {
    // Fail-closed, the same rule the reimbursement addresses follow: a partner report with no
    // recipient must refuse to send, and it can only do that if the field is genuinely empty.
    const service = new AdminBotService();
    const saved = unwrap(
      service.updateSettings({ dcs_server_access_email: "eugenia@cs.toronto.edu" }),
    );
    expect(saved.vector_roster_email).toBeUndefined();
    expect(saved.papers_acceptance_sri_email).toBeUndefined();
    expect(saved.papers_acceptance_mpi_emails).toBeUndefined();
  });

  it("does not disturb a desk an unrelated update never mentioned", () => {
    const service = new AdminBotService();
    unwrap(service.updateSettings({ papers_acceptance_sri_email: "sri.research@utoronto.ca" }));
    const after = unwrap(
      service.updateSettings({ vector_roster_email: "daniel.oltianu@vectorinstitute.ai" }),
    );
    expect(after.papers_acceptance_sri_email).toBe("sri.research@utoronto.ca");
  });

  it("reads a blank field as 'not supplied', so a desk survives an update that omits it", () => {
    // Documenting a real limitation rather than a wish. `normalizeOptionalString` collapses ""
    // to undefined, which every settings field here shares, so a configured desk cannot be
    // un-set through this call -- an empty string leaves the previous address standing. Anything
    // that needs to stop mailing a partner has to clear the row another way, and a caller that
    // assumed otherwise would quietly keep sending.
    const service = new AdminBotService();
    unwrap(service.updateSettings({ vector_roster_email: "daniel.oltianu@vectorinstitute.ai" }));
    const after = unwrap(service.updateSettings({ vector_roster_email: "" }));
    expect(after.vector_roster_email).toBe("daniel.oltianu@vectorinstitute.ai");
  });

  it("drops blanks from the MPI pair instead of mailing an empty recipient", () => {
    const service = new AdminBotService();
    const saved = unwrap(
      service.updateSettings({
        papers_acceptance_mpi_emails: ["karin.bierig@tuebingen.mpg.de", "  ", ""],
      }),
    );
    expect(saved.papers_acceptance_mpi_emails).toEqual(["karin.bierig@tuebingen.mpg.de"]);
  });
});
