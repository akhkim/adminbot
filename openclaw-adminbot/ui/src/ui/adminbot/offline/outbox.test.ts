import { describe, expect, it } from "vitest";
import {
  enqueueAdminBotMutation,
  flushAdminBotOutbox,
  listAdminBotOutbox,
  onDeviceSlmDraftContract,
  resetAdminBotOfflineMemory,
} from "./outbox.ts";

const ADA_SCOPE = { baseUrl: "http://127.0.0.1:8765", principalKey: "ada-session" };
const MEI_SCOPE = { baseUrl: "http://127.0.0.1:8765", principalKey: "mei-session" };

describe("AdminBot offline outbox", () => {
  it("replays mutations in order and stops on failure", async () => {
    await resetAdminBotOfflineMemory();
    await enqueueAdminBotMutation(ADA_SCOPE, {
      method: "PUT",
      path: "/lab/members/ada",
      payload: { name: "Ada" },
    });
    await enqueueAdminBotMutation(ADA_SCOPE, {
      method: "POST",
      path: "/feedback",
      payload: { text: "hi" },
    });
    const sent: string[] = [];
    const first = await flushAdminBotOutbox(ADA_SCOPE, async (item) => {
      sent.push(item.path);
      return item.path.includes("members");
    });
    expect(sent).toEqual(["/lab/members/ada", "/feedback"]);
    expect(first).toEqual({ flushed: 1, remaining: 1 });
  });

  it("only lists and replays mutations created by the same member and origin", async () => {
    await resetAdminBotOfflineMemory();
    await enqueueAdminBotMutation(ADA_SCOPE, {
      method: "PUT",
      path: "/lab/members/ada",
      payload: { name: "Ada" },
    });
    await enqueueAdminBotMutation(MEI_SCOPE, {
      method: "PUT",
      path: "/lab/members/mei",
      payload: { name: "Mei" },
    });
    const sent: string[] = [];

    await flushAdminBotOutbox(MEI_SCOPE, async (item) => {
      sent.push(item.path);
      return true;
    });

    expect(sent).toEqual(["/lab/members/mei"]);
    await expect(listAdminBotOutbox(ADA_SCOPE)).resolves.toHaveLength(1);
    await expect(listAdminBotOutbox(MEI_SCOPE)).resolves.toHaveLength(0);
  });

  it("keeps the on-device SLM as an unwired interview contract", () => {
    expect(onDeviceSlmDraftContract().status).toBe("unwired");
  });
});
