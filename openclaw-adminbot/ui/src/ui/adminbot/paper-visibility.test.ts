import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { readHiddenPapers, writeHiddenPapers } from "./hidden-papers.ts";
import { PaperVisibility } from "./paper-visibility.ts";

beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
it("selects matching papers, preserves prior hidden papers and isolates members", async () => {
  writeHiddenPapers("ada", new Set(["older"]));
  const view = document.createElement("adminbot-paper-visibility") as PaperVisibility;
  view.memberId = "ada";
  view.papers = [
    { id: "p1", title: "Agents" },
    { id: "p2", title: "Agents at scale" },
    { id: "p3", title: "Biology" },
  ];
  document.body.append(view);
  await view.updateComplete;
  await view.updateComplete;
  const search = view.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "agents";
  search.dispatchEvent(new Event("input"));
  await view.updateComplete;
  const buttons = () => [...view.querySelectorAll<HTMLButtonElement>("button")];
  buttons()
    .find((b) => b.textContent?.includes("Select matching"))!
    .click();
  await view.updateComplete;
  expect(view.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(2);
  buttons()
    .find((b) => b.textContent?.includes("Hide selected"))!
    .click();
  await view.updateComplete;
  expect([...readHiddenPapers("ada")].sort()).toEqual(["older", "p1", "p2"]);
  expect(readHiddenPapers("other").size).toBe(0);
  expect(buttons().find((b) => b.textContent?.includes("Hide selected"))!.disabled).toBe(true);
});
