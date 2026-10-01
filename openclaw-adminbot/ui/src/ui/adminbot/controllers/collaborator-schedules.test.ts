import { beforeEach, expect, it, vi } from "vitest";
import type { UiSettings } from "../../storage.ts";
import { fetchMemberResource, loadStoredMemberSession } from "../auth/session.ts";
import { loadCollaboratorSchedules } from "./collaborator-schedules.ts";
vi.mock("../auth/session.ts", () => ({
  fetchMemberResource: vi.fn(),
  loadStoredMemberSession: vi.fn(),
  resolveAdminBotBaseUrl: () => "https://example.org",
}));
function host() {
  return {
    settings: {} as UiSettings,
    adminBotCollaboratorSchedules: [],
    adminBotCollaboratorSchedulesLoading: false,
    adminBotCollaboratorSchedulesError: null as string | null,
    adminBotCollaboratorSchedulesSession: "",
  };
}
beforeEach(() => vi.resetAllMocks());
it("discards a response after the authenticated session changes", async () => {
  vi.mocked(loadStoredMemberSession).mockReturnValue({ sessionToken: "first" } as ReturnType<
    typeof loadStoredMemberSession
  >);
  let finish!: (value: Awaited<ReturnType<typeof fetchMemberResource>>) => void;
  vi.mocked(fetchMemberResource).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const h = host();
  const pending = loadCollaboratorSchedules(h);
  expect(h.adminBotCollaboratorSchedulesLoading).toBe(true);
  vi.mocked(loadStoredMemberSession).mockReturnValue({ sessionToken: "second" } as ReturnType<
    typeof loadStoredMemberSession
  >);
  finish({ ok: true, value: { members: [{ id: "private-peer", name: "Peer" }] } });
  await pending;
  expect(h.adminBotCollaboratorSchedules).toEqual([]);
  expect(h.adminBotCollaboratorSchedulesLoading).toBe(false);
});
it("rejects malformed responses and prevents duplicate concurrent reads", async () => {
  vi.mocked(loadStoredMemberSession).mockReturnValue({ sessionToken: "first" } as ReturnType<
    typeof loadStoredMemberSession
  >);
  vi.mocked(fetchMemberResource).mockResolvedValue({ ok: true, value: {} });
  const h = host();
  const pending = loadCollaboratorSchedules(h);
  await loadCollaboratorSchedules(h);
  await pending;
  expect(fetchMemberResource).toHaveBeenCalledTimes(1);
  expect(h.adminBotCollaboratorSchedulesError).toContain("Invalid collaborator");
  expect(h.adminBotCollaboratorSchedules).toEqual([]);
});
