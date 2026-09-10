// Mailing a cleared package to the funder's office: who it goes to, who answers it, and the two
// ways it refuses.
import { describe, expect, it } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const ARTIFACTS = [{ filename: "MPI_IS_Reimbursement_Ada.pdf", data_base64: "JVBERi0=" }];

function seeded(settings: Record<string, string> = {}) {
  const executed: AdminBotStoredProposal[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        executed.push(proposal);
        return { handled: proposal.type === "reimbursement.submit" };
      },
    },
  });
  unwrap(
    service.upsertLabMember({
      id: "ada",
      name: "Ada Lovelace",
      email: "ada@cs.toronto.edu",
      correspondence_email: "ada.personal@example.org",
      privilege_level: "member",
      status: "active",
    } as never),
  );
  if (Object.keys(settings).length) {
    unwrap(service.updateSettings(settings as never, "admin"));
  }
  return { service, executed };
}

describe("submitReimbursement", () => {
  it("mails the funder's office with the forms attached", async () => {
    const { service, executed } = seeded({ reimbursement_mpi_email: "secretariat@tue.mpg.de" });
    const result = unwrap(
      await service.submitReimbursement({
        funder: "MPI-IS",
        memberId: "ada",
        artifacts: ARTIFACTS,
        tripTitle: "EMNLP 2026",
      }),
    );
    expect(result.to).toBe("secretariat@tue.mpg.de");
    expect(executed).toHaveLength(1);
    const payload = executed[0]?.proposed_payload as Record<string, unknown>;
    expect(payload.to).toBe("secretariat@tue.mpg.de");
    expect(payload.attachments).toHaveLength(1);
    expect(String(payload.subject)).toContain("Ada Lovelace");
  });

  it("sets reply-to to the correspondence address, not the bot", async () => {
    const { service, executed } = seeded({ reimbursement_dcs_email: "gizelda@cs.toronto.edu" });
    const result = unwrap(
      await service.submitReimbursement({ funder: "DCS", memberId: "ada", artifacts: ARTIFACTS }),
    );
    // A reply landing in a bot mailbox is a question nobody answers.
    expect(result.reply_to).toBe("ada.personal@example.org");
    expect((executed[0]?.proposed_payload as Record<string, unknown>).reply_to).toBe(
      "ada.personal@example.org",
    );
  });

  it("routes by funder, so one office never receives the other's package", async () => {
    const { service } = seeded({
      reimbursement_dcs_email: "gizelda@cs.toronto.edu",
      reimbursement_mpi_email: "secretariat@tue.mpg.de",
    });
    const dcs = unwrap(
      await service.submitReimbursement({ funder: "DCS", memberId: "ada", artifacts: ARTIFACTS }),
    );
    const mpi = unwrap(
      await service.submitReimbursement({
        funder: "MPI-IS",
        memberId: "ada",
        artifacts: ARTIFACTS,
      }),
    );
    expect(dcs.to).toBe("gizelda@cs.toronto.edu");
    expect(mpi.to).toBe("secretariat@tue.mpg.de");
  });

  it("refuses rather than guessing when the office address is unset", async () => {
    const { service, executed } = seeded();
    const result = await service.submitReimbursement({
      funder: "MPI-IS",
      memberId: "ada",
      artifacts: ARTIFACTS,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(String((result as { error: { message: string } }).error.message)).toContain(
      "reimbursement_mpi_email",
    );
    // Nothing was sent: an unset recipient is not a reason to fall back to somebody plausible.
    expect(executed).toEqual([]);
  });

  it("refuses with nothing to attach", async () => {
    const { service } = seeded({ reimbursement_dcs_email: "gizelda@cs.toronto.edu" });
    expect(
      await service.submitReimbursement({ funder: "DCS", memberId: "ada", artifacts: [] }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("goes through the proposal machinery, so the send is audited", async () => {
    const { service } = seeded({ reimbursement_dcs_email: "gizelda@cs.toronto.edu" });
    const result = unwrap(
      await service.submitReimbursement({ funder: "DCS", memberId: "ada", artifacts: ARTIFACTS }),
    );
    expect(result.proposal_id).toMatch(/^act_/u);
    const audit = service
      .listAuditEvents()
      .filter((event) => event.action_id === result.proposal_id);
    expect(audit.length).toBeGreaterThan(0);
  });
});
