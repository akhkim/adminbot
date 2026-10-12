import { describe, expect, it, vi } from "vitest";
import { createAdminBotOnboardingSender } from "./guide-sender.js";
import { interviewBody, readInterviewInvitation } from "./interview.js";

describe("interview invitations", () => {
  const interview = {
    project: "Example project",
    task: "Implement {example_code} and report results.",
    interviewer_ids: ["UINTERVIEW1", "UINTERVIEW2"],
  };
  it("validates task bounds and distinct interviewer identities", () => {
    expect(readInterviewInvitation(interview)).toEqual(interview);
    for (const value of [
      null,
      { ...interview, task: "" },
      { ...interview, task: "x".repeat(12001) },
      { ...interview, interviewer_ids: ["UINTERVIEW1", "UINTERVIEW1"] },
      { ...interview, interviewer_ids: ["UINTERVIEW1", "bad"] },
    ]) {
      expect(() => readInterviewInvitation(value)).toThrow();
    }
  });
  it("previews without provisioning and sends only through the private interview channel", async () => {
    const provision = vi.fn(async () => "CINTERVIEW");
    const invite = vi.fn(async () => ({ url: "https://slack.example/invite" }));
    const email = vi.fn(async () => {});
    const sender = createAdminBotOnboardingSender({
      env: {},
      provisionInterviewChannel: provision,
      inviteToSlackConnect: invite,
      sendEmail: email,
    });
    const request = {
      template_id: "interviewee",
      name: "Example Candidate",
      email: "candidate@example.com",
      interview,
      body_override: interviewBody(interview.task),
      subject_override: "Interview task",
      values: {
        slack_connect_link: "https://slack.example/untrusted-room",
        project_or_context: interview.project,
        interviewer_names: "Example One and Example Two",
        sender_name: "Example Proposer",
      },
    };
    expect((await sender({ ...request, preview: true })).ok).toBe(true);
    expect(provision).not.toHaveBeenCalled();
    expect(invite).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
    const sent = await sender(request);
    expect(sent.ok).toBe(true);
    expect(provision).toHaveBeenCalledWith(request.email, interview);
    expect(invite).toHaveBeenCalledWith({ email: request.email, channelId: "CINTERVIEW" });
    expect(email).toHaveBeenCalledWith(
      expect.objectContaining({ to: request.email, body: expect.stringContaining(interview.task) }),
    );
  });
  it("fails closed when private provisioning is unavailable", async () => {
    const sender = createAdminBotOnboardingSender({
      env: {},
      inviteToSlackConnect: async () => ({ url: "https://slack.example" }),
      sendEmail: async () => {
        throw new Error("must not send");
      },
    });
    const result = await sender({
      template_id: "interviewee",
      name: "Example",
      email: "candidate@example.com",
      interview,
      body_override: interviewBody(interview.task),
      values: {
        project_or_context: "Example",
        interviewer_names: "One and Two",
        sender_name: "Example",
      },
    });
    expect(result.ok).toBe(false);
  });
});
