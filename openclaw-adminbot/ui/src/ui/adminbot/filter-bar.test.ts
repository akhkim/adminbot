import { html, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { AdminBotFilterBar, type FilterBarField, filterOptions } from "./filter-bar.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const fields = (status = "", project = ""): FilterBarField[] => [
  {
    name: "status",
    label: "Status",
    options: filterOptions(["active", "alumni"], (value) => value.toUpperCase()),
    value: status,
  },
  {
    name: "project",
    label: "Project",
    options: filterOptions(["Atlas", "Beacon"]),
    value: project,
  },
];

async function setup(status = "", project = "") {
  const form = document.createElement("form");
  document.body.append(form);
  const draw = (nextStatus: string, nextProject: string) =>
    render(
      html`<adminbot-filter-bar
        placeholder="Search people"
        .fields=${fields(nextStatus, nextProject)}
      ></adminbot-filter-bar>`,
      form,
    );
  draw(status, project);
  const bar = form.querySelector<AdminBotFilterBar>("adminbot-filter-bar")!;
  await bar.updateComplete;
  await bar.updateComplete;
  return { form, bar, draw };
}

const chips = (bar: AdminBotFilterBar) =>
  [...bar.querySelectorAll(".adminbot-filter-chip > span:first-child")].map((chip) =>
    chip.textContent?.trim(),
  );

it("shows one search box and keeps every filter behind the Filters button", async () => {
  const { form, bar } = await setup();
  expect(bar.querySelectorAll("input[type=search]")).toHaveLength(1);
  expect(bar.querySelector("input")?.placeholder).toBe("Search people");
  const toggle = bar.querySelector<HTMLButtonElement>("[popovertarget]")!;
  const panel = bar.querySelector<HTMLElement>("[popover]")!;
  expect(toggle.getAttribute("popovertarget")).toBe(panel.id);
  expect(toggle.textContent?.trim()).toBe("Filters");
  expect(panel.querySelectorAll("select")).toHaveLength(2);
  expect(bar.querySelector(".adminbot-filter-bar__chips")).toBeNull();
  // The fields still belong to the page's form.
  expect([...new FormData(form).keys()]).toEqual(["search", "status", "project"]);
});

it("turns a set filter into a removable chip and counts it on the button", async () => {
  const { form, bar } = await setup();
  const onChange = vi.fn();
  form.addEventListener("change", onChange);
  const status = bar.querySelector<HTMLSelectElement>('select[name="status"]')!;
  status.value = "alumni";
  status.dispatchEvent(new Event("change", { bubbles: true }));
  await bar.updateComplete;
  expect(chips(bar)).toEqual(["Status: ALUMNI"]);
  expect(bar.querySelector(".adminbot-filter-bar__count")?.textContent).toBe("1");

  bar.querySelector<HTMLButtonElement>(".adminbot-filter-chip")!.click();
  await bar.updateComplete;
  expect(status.value).toBe("");
  expect(new FormData(form).get("status")).toBe("");
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(chips(bar)).toEqual([]);
  expect(bar.querySelector(".adminbot-filter-bar__count")).toBeNull();
});

it("starts from the values the page applied and clears them all with one change event", async () => {
  const { form, bar, draw } = await setup("active", "Beacon");
  expect(chips(bar)).toEqual(["Status: ACTIVE", "Project: Beacon"]);
  const onChange = vi.fn();
  form.addEventListener("change", onChange);
  [...bar.querySelectorAll<HTMLButtonElement>("[popover] button")]
    .find((button) => button.textContent?.includes("Clear all"))!
    .click();
  await bar.updateComplete;
  expect(onChange).toHaveBeenCalledOnce();
  expect(new FormData(form).get("project")).toBe("");
  expect(chips(bar)).toEqual([]);

  // A later render from the page selects what it applied.
  draw("", "Atlas");
  await bar.updateComplete;
  await bar.updateComplete;
  expect(new FormData(form).get("project")).toBe("Atlas");
  expect(chips(bar)).toEqual(["Project: Atlas"]);
});

it("picks up a value set from outside after sync()", async () => {
  const { bar } = await setup();
  bar.querySelector<HTMLSelectElement>('select[name="project"]')!.value = "Atlas";
  bar.sync();
  await bar.updateComplete;
  expect(chips(bar)).toEqual(["Project: Atlas"]);
});
