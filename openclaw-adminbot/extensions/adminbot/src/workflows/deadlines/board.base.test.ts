import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderDeadlinesWebUi } from "./board.js";
import { DEADLINE_VENUES } from "./generated/dataset.js";

const items = [
  {
    name: "First Workshop",
    venue_group: "TEST 2035 Workshops",
    entry_type: "workshop",
    archival_status: "archival",
    archival: true,
    deadline_label: "submission",
    deadline_aoe: "2035-01-02 12:30:00",
    notification_aoe: "2035-01-10 23:59:59",
    link: "https://example.test/first",
  },
  {
    name: "Second Workshop",
    venue_group: "TEST 2035 Workshops",
    entry_type: "workshop",
    archival_status: "non_archival",
    archival: false,
    deadline_label: "submission",
    deadline_aoe: "2035-01-03 23:59:59",
    notification_aoe: null,
    link: "https://example.test/second",
  },
];

describe("standalone deadline board foundation", () => {
  it("keeps derived counts, exact times, and compact metadata aligned with its filters", () => {
    const dom = new JSDOM(renderDeadlinesWebUi(items), {
      runScripts: "dangerously",
      url: "http://localhost/deadlines",
      beforeParse(window) {
        window.Date.now = () => Date.UTC(2035, 0, 3, 0, 0, 0);
      },
    });
    try {
      const document = dom.window.document;
      expect(document.querySelectorAll(".stat")).toHaveLength(4);
      expect(document.querySelector("#s-total")?.textContent).toBe("2");
      expect(document.querySelector<HTMLInputElement>("#search")?.placeholder).toBe(
        "Search conferences & workshops…",
      );
      expect(
        [...document.querySelectorAll(".modes .toggle button")].map((button) => button.textContent),
      ).toEqual(["Groups", "Cards", "Table"]);
      expect(document.querySelector("#v-groups")?.getAttribute("aria-pressed")).toBe("true");
      expect(document.querySelector("#group-list")?.classList).not.toContain("hidden");
      expect(document.querySelector("#grid")?.classList).toContain("hidden");
      document.querySelector<HTMLButtonElement>("#v-cards")!.click();
      expect(document.querySelector(".hero .hmeta")?.textContent).toContain("12:30 AoE");
      expect(document.querySelector(".card .cdl")?.textContent).toContain("12:30 AoE");
      expect(document.querySelector(".card .ccd")?.textContent).toBe("0d 00:30:00");
      expect(document.querySelector(".cgroup-name")?.textContent).toBe("TEST 2035 Workshops");
      expect(document.querySelector(".cgroup-stage")?.textContent).toBe("Submission");
      const children = [...document.querySelector(".container")!.children];
      expect(children.indexOf(document.querySelector(".modes")!)).toBeLessThan(
        children.indexOf(document.querySelector(".controls")!),
      );
      expect(children.indexOf(document.querySelector(".controls")!)).toBeLessThan(
        children.indexOf(document.querySelector(".top")!),
      );
      expect(
        document.querySelector(".archival-guide")?.textContent?.replace(/\s+/gu, " "),
      ).toContain(
        "Non-archival does not count as publishing; you can still submit the paper elsewhere.",
      );

      const search = document.querySelector<HTMLInputElement>("#search")!;
      search.value = "First Workshop";
      search.dispatchEvent(new dom.window.Event("input"));
      expect(document.querySelector("#s-total")?.textContent).toBe("1");
      expect(document.querySelector(".chip .ct")?.textContent).toBe("1");
      expect(document.querySelector("#foot")?.textContent).toContain("Showing 1 of 1");

      search.value = "";
      search.dispatchEvent(new dom.window.Event("input"));
      document.querySelector<HTMLButtonElement>("#v-groups")!.click();
      expect(document.querySelectorAll(".deadline-group")).toHaveLength(1);
      expect(document.querySelector(".deadline-group__count")?.textContent).toBe(
        "1 archival · 1 non-archival",
      );
      expect(
        [...document.querySelectorAll(".deadline-group__section-head strong")].map(
          (node) => node.textContent,
        ),
      ).toEqual(["Archival", "Non-archival"]);
      document.querySelector<HTMLButtonElement>(".deadline-group__summary")!.click();
      expect(document.querySelectorAll(".deadline-group__row")).toHaveLength(2);
      expect(document.querySelector(".deadline-group__row-date")?.textContent).toContain(
        "12:30 AoE",
      );
      expect(document.querySelector(".deadline-group__row-countdown")?.textContent).toBe(
        "0d 00:30:00",
      );
      const note = document.querySelector(".deadline-group__row-note")!;
      expect(note.querySelector(".deadline-group__row-detail")?.textContent).toContain(
        "Submission · Accept/reject",
      );
      expect([...note.children].map((element) => element.className)).toEqual([
        "deadline-group__row-detail",
        "labels",
      ]);
      expect(
        [...document.querySelector(".deadline-group__row")!.children]
          .slice(0, 3)
          .map((element) => element.className),
      ).toEqual([
        "deadline-group__row-countdown",
        "deadline-group__row-date",
        "deadline-group__row-main",
      ]);

      document.querySelector<HTMLButtonElement>("#v-table")!.click();
      expect(document.querySelector("tbody .tcd")?.textContent).toContain("12:30 AoE");
      expect(document.querySelector("tbody .badge")?.textContent).toBe("Workshop");

      const css = document.querySelector("style")?.textContent ?? "";
      expect(css).toMatch(/\.cd \.num\s*\{[^}]*color: var\(--h-color/u);
      expect(css).toMatch(/\.ccd\s*\{[^}]*color: var\(--u\)/u);
    } finally {
      dom.window.close();
    }
  });

  it("uses generated workshop labels in cards and grouped headings", () => {
    const dom = new JSDOM(renderDeadlinesWebUi(DEADLINE_VENUES), {
      runScripts: "dangerously",
      url: "http://localhost/deadlines",
      beforeParse(window) {
        window.Date.now = () => Date.UTC(2026, 6, 25, 0, 0, 0);
      },
    });
    try {
      const document = dom.window.document;
      document.querySelector<HTMLButtonElement>("#v-cards")!.click();
      const cardLabels = [...document.querySelectorAll(".cgroup-name")].map((node) =>
        node.textContent?.trim(),
      );
      expect(cardLabels).toContain("EMNLP 2026 Workshops");
      expect(cardLabels).toContain("NeurIPS 2026 Workshops");

      document.querySelector<HTMLButtonElement>("#v-groups")!.click();
      const headings = [...document.querySelectorAll(".deadline-group__heading strong")].map(
        (node) => node.textContent?.trim(),
      );
      expect(headings).toContain("EMNLP 2026 Workshops");
      expect(headings).toContain("NeurIPS 2026 Workshops");
      expect(headings).toContain("ICLR 2027");
      expect(headings).toContain("EACL 2027");
    } finally {
      dom.window.close();
    }
  });
});
