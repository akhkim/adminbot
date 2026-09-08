import { expect, it } from "vitest";
import { AdminBotService, AdminBotMemoryStore } from "./service.js";

it("saves an Overleaf CV while preserving unchanged legacy intake data", () => {
  const store = new AdminBotMemoryStore();
  const service = new AdminBotService(store);
  const result = service.upsertLabMember({ id: "ada", name: "Ada", privilege_level: "member" });
  if (!result.ok) throw new Error(result.error.message);
  store.saveLabMember({ ...result.payload, intake_form_url: "Imported response pending" });
  const saved = service.updateOwnProfile("ada", {
    cv_url: "https://www.overleaf.com/read/synthetic",
    intake_form_url: "Imported response pending",
  });
  expect(saved).toMatchObject({
    ok: true,
    payload: {
      cv_url: "https://www.overleaf.com/read/synthetic",
      intake_form_url: "Imported response pending",
    },
  });
  expect(service.updateOwnProfile("ada", { cv_url: "javascript:alert(1)" })).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(service.updateOwnProfile("ada", { intake_form_url: "new invalid link" })).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(service.updateOwnProfile("ada", { privilege_level: "admin" })).toMatchObject({
    ok: false,
    status: 400,
  });
});
it("preserves legacy Findings when saving a new presentation format", () => {
  const service = new AdminBotService();
  expect(
    service.upsertPaper({
      id: "p",
      title: "Synthetic",
      authors: ["Ada"],
      current_step: "submission",
      presentation_type: "findings",
    }).ok,
  ).toBe(true);
  expect(
    service.upsertPaper({
      id: "p",
      title: "Synthetic",
      authors: ["Ada"],
      current_step: "submission",
      presentation_type: "oral",
    }),
  ).toMatchObject({
    ok: true,
    payload: { presentation_type: "oral", artifacts: { publication_track: "findings" } },
  });
  expect(
    service.upsertPaper({
      id: "p",
      title: "Synthetic",
      authors: ["Ada"],
      current_step: "submission",
      artifacts: { publication_track: "main" },
    }),
  ).toMatchObject({
    ok: true,
    payload: { presentation_type: "oral", artifacts: { publication_track: "main" } },
  });
});

it("does not restore an explicitly cleared legacy publication track", () => {
  const service = new AdminBotService();
  service.upsertPaper({
    id: "legacy",
    title: "Synthetic",
    authors: ["Ada"],
    current_step: "submission",
    presentation_type: "findings",
  });
  service.upsertPaper({
    id: "legacy",
    title: "Synthetic",
    authors: ["Ada"],
    current_step: "submission",
    artifacts: { publication_track: "" },
  });
  expect(
    service.upsertPaper({
      id: "legacy",
      title: "Revised title",
      authors: ["Ada"],
      current_step: "submission",
    }),
  ).toMatchObject({ ok: true, payload: { artifacts: { publication_track: "" } } });
});
