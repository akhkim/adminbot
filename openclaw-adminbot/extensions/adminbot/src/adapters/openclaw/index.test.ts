import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../api/client.js";
import { defaultAdminBotConfig, createAdminBotToolHandlers } from "./index.js";

function captureFetch() {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        return JSON.stringify({ ok: true });
      },
    };
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("AdminBot tool handlers", () => {
  it("maps privacy reasoning to the local service route", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.reason({
      task: "Draft code for account PAT-123",
      privacy: "private",
      sensitiveTerms: ["PAT-123"],
    });

    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:8765/privacy/tasks",
      body: {
        task: "Draft code for account PAT-123",
        privacy: "private",
        sensitive_terms: ["PAT-123"],
      },
    });
  });

  it("maps candidate decisions to T4 action proposals", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.proposeCandidateDecision({
      decision: "accept_for_trial",
      candidateName: "Jane Doe",
      candidateEmail: "jane@example.test",
      summary: "Accept Jane Doe for a two-week trial",
      evidence: [{ source: "google_form", id: "form_1" }],
    });

    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:8765/proposals",
      body: expect.objectContaining({
        type: "candidate.accept_for_trial",
        risk_tier: "T4",
        dry_run: false,
        target: { name: "Jane Doe", email: "jane@example.test" },
      }),
    });
  });

  it("keeps join form classification observational", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.classifyJoinFormResponse({
      responseId: "resp_1",
      applicantName: "Pat",
      answers: { background: "ML" },
      rubric: "research fit",
    });

    expect(calls[0]?.body).toEqual(
      expect.objectContaining({
        type: "join_form.classify",
        risk_tier: "T0",
        evidence: [{ source: "google_form", id: "resp_1" }],
      }),
    );
  });

  it("classifies calendar sends as approval-sensitive", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.suggestCalendarChange({
      changeType: "send_invite",
      summary: "Invite candidate to interview",
      attendees: ["candidate@example.test"],
      timeWindow: "2099-07-30T13:00:00-04:00 through 2099-07-30T14:00:00-04:00",
      proposedPayload: {
        summary: "Invite candidate to interview",
        from: "2099-07-30T13:00:00-04:00",
        to: "2099-07-30T14:00:00-04:00",
        attendees: ["candidate@example.test"],
      },
    });

    expect(calls[0]?.body).toEqual(
      expect.objectContaining({
        type: "calendar.send_invite",
        risk_tier: "T3",
      }),
    );
  });

  it("turns Slack-originated no-email invites into all-day calendar holds", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.suggestCalendarChange({
      changeType: "send_invite",
      summary: "Flight Trip: Stuttgart to London (Jul 21-Jul 23)",
      attendees: ["U09NYHPDDL4"],
    });

    expect(calls[0]?.body).toEqual(
      expect.objectContaining({
        type: "calendar.create_tentative_hold",
        risk_tier: "T2",
        target: expect.objectContaining({ attendees: [] }),
        proposed_payload: expect.objectContaining({
          from: `${new Date().getUTCFullYear()}-07-21`,
          to: `${new Date().getUTCFullYear()}-07-24`,
          all_day: true,
        }),
      }),
    );
    expect(
      (calls[0]?.body as { proposed_payload?: { attendees?: unknown } }).proposed_payload,
    ).not.toHaveProperty("attendees");
  });

  it("lets an explicit timestamp range override a source-derived all-day payload", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.suggestCalendarChange({
      changeType: "tentative_hold",
      summary: "Dinner",
      timeWindow: "2099-07-30T18:30:00-04:00 through 2099-07-30T20:00:00-04:00",
      proposedPayload: {
        from: "2099-07-30",
        to: "2099-07-31",
        all_day: true,
      },
    });

    expect(calls[0]?.body).toEqual(
      expect.objectContaining({
        proposed_payload: expect.objectContaining({
          from: "2099-07-30T18:30:00-04:00",
          to: "2099-07-30T20:00:00-04:00",
          all_day: false,
        }),
      }),
    );
  });

  it("maps Slack messages to OpenClaw message tool proposals", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.proposeSlackMessage({
      target: "U09NYHPDDL4",
      recipientName: "Pat",
      message: "Welcome to the workspace.",
      evidence: [{ source: "slack", id: "thread-1" }],
      idempotencyKey: "slack-dm-u09-welcome",
    });

    expect(calls[0]?.body).toEqual(
      expect.objectContaining({
        type: "slack.send_message",
        risk_tier: "T3",
        summary: "Send Slack message to Pat",
        target: {
          service: "slack",
          channel: "slack",
          target: "U09NYHPDDL4",
          recipientName: "Pat",
        },
        proposed_payload: {
          tool: "message",
          action: "send",
          channel: "slack",
          target: "U09NYHPDDL4",
          message: "Welcome to the workspace.",
        },
        idempotency_key: "slack-dm-u09-welcome",
      }),
    );
  });

  it("prepares approval-gated paper social posts with resolved and missing tags", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      const responseBody = url.endsWith("/lab/members")
        ? {
            members: [
              {
                id: "alice",
                name: "Alice",
                privilege_level: "member",
                access: [],
                notes: "X: @alice\nLinkedIn: @alice-lab",
                created_at: "2026-06-01T00:00:00.000Z",
                updated_at: "2026-06-01T00:00:00.000Z",
              },
            ],
          }
        : url.endsWith("/papers")
          ? {
              papers: [
                {
                  id: "paper-1",
                  title: "Paper One",
                  authors: ["alice", "bob"],
                  current_step: "social_posts",
                  created_at: "2026-06-01T00:00:00.000Z",
                  updated_at: "2026-06-01T00:00:00.000Z",
                },
              ],
            }
          : { ok: true };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify(responseBody);
        },
      };
    }) as FetchLike;
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.preparePaperSocialPosts({
      paperId: "paper-1",
      summary: "Short summary",
      hashtags: ["AI"],
    });

    expect(calls.at(-1)).toMatchObject({
      url: "http://127.0.0.1:8765/proposals",
      body: expect.objectContaining({
        type: "social_media.post_publicly",
        risk_tier: "T4",
        proposed_payload: expect.objectContaining({
          action: "publish_paper_social_posts",
          platforms: ["linkedin", "x"],
          tags: expect.objectContaining({
            missing: expect.arrayContaining([expect.objectContaining({ name: "bob" })]),
          }),
        }),
      }),
    });
  });

  it("prepares approval-gated Overleaf paper edits with affiliation issues", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      const responseBody = url.endsWith("/lab/members")
        ? {
            members: [
              {
                id: "alice",
                name: "Alice",
                privilege_level: "member",
                access: [],
                notes: "Main affiliation: Jinesis",
                created_at: "2026-06-01T00:00:00.000Z",
                updated_at: "2026-06-01T00:00:00.000Z",
              },
            ],
          }
        : url.endsWith("/papers")
          ? {
              papers: [
                {
                  id: "paper-1",
                  title: "Paper One",
                  authors: ["alice", "bob"],
                  current_step: "overleaf_writing",
                  artifacts: { overleaf_edit_url: "https://www.overleaf.com/project/abc" },
                  created_at: "2026-06-01T00:00:00.000Z",
                  updated_at: "2026-06-01T00:00:00.000Z",
                },
              ],
            }
          : { ok: true };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify(responseBody);
        },
      };
    }) as FetchLike;
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.prepareOverleafPaperEdit({
      paperId: "paper-1",
      requestedEdits: "Check affiliations and update author block.",
      mode: "affiliation_check",
    });

    expect(calls.at(-1)).toMatchObject({
      url: "http://127.0.0.1:8765/proposals",
      body: expect.objectContaining({
        type: "paper.overleaf_edit",
        risk_tier: "T4",
        proposed_payload: expect.objectContaining({
          action: "apply_overleaf_project_edits",
          mode: "affiliation_check",
          paper: expect.objectContaining({
            overleafEditUrl: "https://www.overleaf.com/project/abc",
          }),
          affiliationPolicy: expect.objectContaining({
            issues: expect.arrayContaining([expect.objectContaining({ author: "bob" })]),
          }),
        }),
      }),
    });
  });

  it("maps lab member records to the service privilege schema", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.upsertLabMember({
      id: "alice",
      name: "Alice",
      email: "alice@example.test",
      slackUserId: "U123",
      privilegeLevel: "admin",
    });

    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:8765/lab/members/alice",
      body: {
        id: "alice",
        name: "Alice",
        email: "alice@example.test",
        slack_user_id: "U123",
        privilege_level: "admin",
      },
    });
  });

  it("maps the collaborator subgroup onto the member record", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.upsertLabMember({
      id: "rin",
      name: "Rin",
      privilegeLevel: "external_collaborator",
      collaboratorSubgroup: "disappearing_coauthor",
    });

    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:8765/lab/members/rin",
      body: {
        id: "rin",
        name: "Rin",
        privilege_level: "external_collaborator",
        collaborator_subgroup: "disappearing_coauthor",
      },
    });
  });

  it("omits lab member privilege when the service default should apply", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.upsertLabMember({
      id: "pat",
      name: "Pat",
    });

    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:8765/lab/members/pat",
      body: {
        id: "pat",
        name: "Pat",
      },
    });
  });

  it("creates approval-gated paper nudge proposals for the configured head professor", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      const responseBody = url.endsWith("/papers")
        ? {
            papers: [
              {
                id: "paper-1",
                title: "Paper One",
                authors: ["alice"],
                current_step: "social_posts",
                timeline: {
                  progress_percent: 69,
                  current_step_index: 5,
                  total_estimated_business_days: 16,
                  items: [
                    {
                      step: "social_posts",
                      label: "Announcements",
                      dependency_group: "outreach",
                      depends_on: ["arxiv_polish"],
                      status: "current",
                      offset_start_business_day: 11,
                      offset_end_business_day: 12,
                      duration_business_days: 1,
                      color: "#db2777",
                    },
                    {
                      step: "slide_making",
                      label: "Slides",
                      dependency_group: "materials",
                      depends_on: ["social_posts"],
                      status: "upcoming",
                      offset_start_business_day: 12,
                      offset_end_business_day: 14,
                      duration_business_days: 2,
                      color: "#d97706",
                    },
                  ],
                },
                created_at: "2026-06-01T00:00:00.000Z",
                updated_at: "2026-06-01T00:00:00.000Z",
              },
            ],
          }
        : url.endsWith("/lab/members")
          ? {
              members: [
                {
                  id: "zhijing",
                  name: "Zhijing",
                  slack_user_id: "U123",
                  privilege_level: "admin",
                  access: [],
                  created_at: "2026-06-01T00:00:00.000Z",
                  updated_at: "2026-06-01T00:00:00.000Z",
                },
              ],
            }
          : url.endsWith("/settings")
            ? {
                paper_escalation_business_days: 3,
                head_professor_member_id: "zhijing",
                updated_at: "2026-06-01T00:00:00.000Z",
              }
            : { ok: true };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify(responseBody);
        },
      };
    }) as FetchLike;
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.proposePaperNudge({ paperId: "paper-1", idempotencyKey: "nudge-paper-1" });

    expect(calls.at(-1)).toMatchObject({
      url: "http://127.0.0.1:8765/proposals",
      body: expect.objectContaining({
        type: "paper_publish.nudge_author",
        risk_tier: "T3",
        summary: "Ask Zhijing to nudge paper authors: Paper One",
        proposed_payload: expect.objectContaining({
          tool: "message",
          action: "send",
          channel: "slack",
          target: "user:U123",
          timeline: expect.objectContaining({ progress_percent: 69 }),
        }),
        idempotency_key: "nudge-paper-1",
      }),
    });
  });
  it("maps settings and paper list helpers to the service endpoints", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.getSettings();
    await tools.updateSettings({
      paper_escalation_business_days: 3,
      head_professor_member_id: "zhijing",
    });
    await tools.listPapers();

    expect(calls).toEqual([
      { url: "http://127.0.0.1:8765/settings", body: undefined },
      {
        url: "http://127.0.0.1:8765/settings",
        body: {
          paper_escalation_business_days: 3,
          head_professor_member_id: "zhijing",
        },
      },
      { url: "http://127.0.0.1:8765/papers", body: undefined },
    ]);
  });

  it("maps sensitive-info helpers to the markdown endpoint", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.getSensitiveInfo();
    await tools.updateSensitiveInfo({ markdown: "# Sensitive\n" });

    expect(calls).toEqual([
      { url: "http://127.0.0.1:8765/sensitive-info", body: undefined },
      {
        url: "http://127.0.0.1:8765/sensitive-info",
        body: { markdown: "# Sensitive\n" },
      },
    ]);
  });

  it("maps paper records and nudge checks to the service endpoints", async () => {
    const { fetchImpl, calls } = captureFetch();
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.upsertPaper({
      id: "paper-1",
      title: "Paper One",
      authors: ["alice"],
      currentStep: "social_posts",
      artifacts: {
        google_drive_pdf_url: "https://drive.example/pdf",
        twitter_draft_url: "https://x.example/draft",
      },
      reminder: {
        status: "waiting_on_authors",
        head_professor_member_id: "zhijing",
      },
    });
    await tools.listPaperNudges({ nowIso: "2026-06-04T00:00:00.000Z" });

    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:8765/papers/paper-1",
      body: {
        id: "paper-1",
        title: "Paper One",
        authors: ["alice"],
        current_step: "social_posts",
        artifacts: {
          google_drive_pdf_url: "https://drive.example/pdf",
          twitter_draft_url: "https://x.example/draft",
        },
        reminder: {
          status: "waiting_on_authors",
          head_professor_member_id: "zhijing",
        },
      },
    });
    expect(calls[1]).toEqual({
      url: "http://127.0.0.1:8765/papers/nudges?now=2026-06-04T00%3A00%3A00.000Z",
      body: undefined,
    });
  });
});

function settingsFetch(settings: Record<string, unknown>) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        return JSON.stringify(settings);
      },
    };
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("AdminBot applicant review handlers", () => {
  it("lists only applicants submitted after the stored review cursor", async () => {
    const { fetchImpl, calls } = settingsFetch({
      applicant_sheet_id: "sheet-1",
      applicant_last_reviewed_at: "2026-07-10T00:00:00.000Z",
    });
    const readSheetRows = vi.fn(async () => [
      ["Timestamp", "Full Name", "Email", "Link to your CV"],
      ["2026-07-01T10:00:00Z", "Ada Lovelace", "ada@example.test", "https://drive.example/ada"],
      ["2026-07-20T09:30:00Z", "Alan Turing", "alan@example.test", "https://drive.example/alan"],
    ]);
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl, readSheetRows });

    await expect(tools.listUnreviewedApplicants({})).resolves.toEqual({
      sheet_id: "sheet-1",
      since: "2026-07-10T00:00:00.000Z",
      applicants: [
        {
          name: "Alan Turing",
          email: "alan@example.test",
          cv_link: "https://drive.example/alan",
          submitted_at: "2026-07-20T09:30:00Z",
        },
      ],
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:8765/settings");
    expect(readSheetRows).toHaveBeenCalledWith("sheet-1", {});
  });

  it("fails clearly when no applicant sheet is configured", async () => {
    const { fetchImpl } = settingsFetch({});
    const readSheetRows = vi.fn(async () => []);
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl, readSheetRows });

    await expect(tools.listUnreviewedApplicants({})).rejects.toThrow(
      "no applicant sheet configured, set it in AdminBot settings first",
    );
    expect(readSheetRows).not.toHaveBeenCalled();
  });

  it("advances the review cursor through the settings update path", async () => {
    const { fetchImpl, calls } = settingsFetch({ applicant_sheet_id: "sheet-1" });
    const tools = createAdminBotToolHandlers(defaultAdminBotConfig, { fetchImpl });

    await tools.markApplicantsReviewed({ reviewedAt: "2026-07-24T12:00:00.000Z" });

    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:8765/settings",
      body: { applicant_last_reviewed_at: "2026-07-24T12:00:00.000Z" },
    });
  });
});
