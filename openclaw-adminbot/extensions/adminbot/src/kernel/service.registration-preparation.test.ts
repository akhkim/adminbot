import { afterEach, expect, it, vi } from "vitest";
import { AdminBotMemoryStore } from "../persistence/memory.js";
import { AdminBotService } from "./service.js";

afterEach(() => vi.useRealTimers());

it("prepares a signup without writes and preserves the normal member hooks after commit", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T00:00:00.000Z"));
  const input = {
    id: "mem_signup",
    name: "Ava Example",
    privilege_level: "member" as const,
    email: "ava@example.test",
    research_topics: ["causality"],
    location: "Toronto",
  };
  const store = new AdminBotMemoryStore();
  const service = new AdminBotService(store);
  const prepared = service.prepareLabMember(input);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    return;
  }
  expect(store.getLabMember(input.id)).toBeUndefined();
  expect(store.listAuditEvents()).toEqual([]);
  expect(store.listPending()).toEqual([]);

  store.saveLabMember(prepared.payload);
  service.afterMemberCreated(prepared.payload);

  const originalStore = new AdminBotMemoryStore();
  const originalService = new AdminBotService(originalStore);
  const original = originalService.upsertLabMember(input);
  expect(original.ok).toBe(true);
  expect(store.getLabMember(input.id)).toEqual(originalStore.getLabMember(input.id));
  expect(store.listAuditEvents().map(({ type }) => type)).toEqual(
    originalStore.listAuditEvents().map(({ type }) => type),
  );
  expect(store.listPending().map(({ type }) => type)).toEqual(
    originalStore.listPending().map(({ type }) => type),
  );
});
