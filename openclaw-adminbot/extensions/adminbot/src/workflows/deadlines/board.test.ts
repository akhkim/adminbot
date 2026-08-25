import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderDeadlinesWebUi } from "./board.js";

const workshops = [
  {
    id: "linked-workshop",
    name: "Linked Workshop",
    venue_group: "TEST Workshops",
    entry_type: "workshop",
    archival_status: "unknown",
    venue_priority: "standard",
    deadline_label: "submission",
    deadline_aoe: "2035-01-02 23:59:59",
    notification_aoe: null,
    link: "https://workshop.example",
    homepage_url: "https://workshop.example",
    cfp_url: "https://workshop.example/cfp",
    openreview_url: "https://openreview.net/group?id=TEST/Workshop",
  },
  {
    id: "homepage-only-workshop",
    name: "Homepage-only Workshop",
    venue_group: "TEST Workshops",
    entry_type: "workshop",
    archival_status: "unknown",
    venue_priority: "standard",
    deadline_label: "submission",
    deadline_aoe: "2035-01-03 23:59:59",
    notification_aoe: null,
    link: "https://homepage.example",
    homepage_url: "https://homepage.example",
    cfp_url: "",
    openreview_url: "",
  },
];

describe("standalone deadline board", () => {
  it("routes deadline proposals to the configured signed-in Control UI", () => {
    const dom = new JSDOM(
      renderDeadlinesWebUi(workshops, {
        proposalUrl: "https://portal.example/adminbot/deadlines",
      }),
    );
    try {
      expect(dom.window.document.querySelector<HTMLAnchorElement>(".proposal-link")?.href).toBe(
        "https://portal.example/adminbot/deadlines",
      );
    } finally {
      dom.window.close();
    }
  });

  it("uses the same safe workshop title and OpenReview links as the Control UI", () => {
    const dom = new JSDOM(renderDeadlinesWebUi(workshops), {
      runScripts: "dangerously",
      url: "http://localhost/deadlines",
    });
    try {
      const document = dom.window.document;
      document.querySelector<HTMLButtonElement>("#v-cards")!.click();
      const cards = [...document.querySelectorAll<HTMLElement>(".card")];
      const linked = cards.find((card) => card.textContent?.includes("Linked Workshop"))!;
      const homepage = cards.find((card) => card.textContent?.includes("Homepage-only Workshop"))!;

      expect(linked.dataset.entryType).toBe("workshop");
      expect(linked.dataset.archivalStatus).toBe("unknown");
      expect(linked.querySelector(".priority")).toBeNull();
      expect(linked.querySelector(".archival")?.textContent).toBe(
        "Archival status not established",
      );
      expect(document.querySelector<HTMLAnchorElement>(".hero .hname a")?.href).toBe(
        "https://workshop.example/",
      );
      expect(linked.querySelector<HTMLAnchorElement>(".cname a")?.href).toBe(
        "https://workshop.example/",
      );
      const linkedActions = [...linked.querySelectorAll<HTMLAnchorElement>(".clink")];
      expect(
        linkedActions.find((link) => link.textContent?.includes("Call for papers"))?.href,
      ).toBe("https://workshop.example/cfp");
      expect(linkedActions.find((link) => link.textContent?.includes("OpenReview"))?.href).toBe(
        "https://openreview.net/group?id=TEST/Workshop",
      );
      expect(homepage.querySelector<HTMLAnchorElement>(".cname a")?.href).toBe(
        "https://homepage.example/",
      );
      expect(homepage.querySelector<HTMLAnchorElement>(".clink")?.textContent).toContain(
        "Official site",
      );
      document.querySelector<HTMLButtonElement>("#v-groups")!.click();
      document.querySelector<HTMLButtonElement>(".deadline-group__summary")!.click();
      const grouped = [...document.querySelectorAll<HTMLElement>(".deadline-group__row")].find(
        (row) => row.textContent?.includes("Linked Workshop"),
      )!;
      expect(grouped.querySelector<HTMLAnchorElement>(".deadline-group__row-name a")?.href).toBe(
        "https://workshop.example/",
      );
      const groupedActions = [...grouped.querySelectorAll<HTMLAnchorElement>(".clink")];
      expect(
        groupedActions.find((link) => link.textContent?.includes("Call for papers"))?.href,
      ).toBe("https://workshop.example/cfp");
      expect(groupedActions.find((link) => link.textContent?.includes("OpenReview"))?.href).toBe(
        "https://openreview.net/group?id=TEST/Workshop",
      );
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        ".cname a, .deadline-group__row-name a, .clink",
      )) {
        expect(link.target).toBe("_blank");
        expect(link.rel.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
      }
    } finally {
      dom.window.close();
    }
  });

  it("switches to retained past deadlines with the same filters and summary", () => {
    const dom = new JSDOM(
      renderDeadlinesWebUi([
        ...workshops,
        {
          id: "past-main",
          name: "Past Main Conference",
          venue_group: "TEST 2020",
          entry_type: "main_conference",
          archival_status: "archival",
          venue_priority: "primary",
          deadline_label: "paper",
          deadline_aoe: "2020-01-02 23:59:59",
          notification_aoe: null,
          link: "https://conference.example",
          homepage_url: "https://conference.example",
          cfp_url: "",
          openreview_url: "",
          revisions: [],
        },
      ]),
      { runScripts: "dangerously", url: "http://localhost/deadlines" },
    );
    try {
      const document = dom.window.document;
      expect(
        [...document.querySelectorAll('[aria-label="Deadline period"] button')].map((button) =>
          button.textContent?.trim(),
        ),
      ).toEqual(["Past", "Upcoming"]);
      document.querySelector<HTMLButtonElement>("#p-past")!.click();
      document.querySelector<HTMLButtonElement>("#v-cards")!.click();

      expect(document.querySelector(".hero .lbl")?.textContent).toContain("Most recent deadline");
      expect(document.querySelectorAll(".card")).toHaveLength(1);
      const card = document.querySelector<HTMLElement>(".card")!;
      expect(card.textContent).toContain("Past Main Conference");
      expect(card.dataset.entryType).toBe("main_conference");
      expect(card.dataset.archivalStatus).toBe("archival");
      expect(card.dataset.venuePriority).toBe("primary");
      expect(card.querySelector(".priority")?.textContent).toBe("Primary");
      expect(card.querySelector(".archival")?.textContent).toBe("Archival");
      expect(document.querySelector("#foot")?.textContent).toContain(
        "Showing 1 of 1 matching past deadlines",
      );
      expect(document.querySelector(".hero .hmeta")?.textContent).toContain("23:59 AoE");
      expect(document.querySelector("#s-today-label")?.textContent).toBe("Passed today");

      document.querySelector<HTMLButtonElement>("#v-groups")!.click();
      expect(document.querySelectorAll(".deadline-group")).toHaveLength(1);
      expect(document.querySelector(".deadline-group__summary-countdown")?.textContent).toBe(
        "passed",
      );
      document.querySelector<HTMLButtonElement>(".deadline-group__summary")!.click();
      expect(document.querySelector(".deadline-group__row-countdown")?.textContent).toBe("passed");
      expect(document.querySelector(".deadline-group__row-date")?.textContent).toContain(
        "23:59 AoE",
      );
      document.querySelector<HTMLButtonElement>("#v-cards")!.click();

      const entryType = document.querySelector<HTMLSelectElement>("#entry-type")!;
      expect([...entryType.options].every((option) => / \(\d+\)$/u.test(option.textContent))).toBe(
        true,
      );
      entryType.value = "workshop";
      entryType.dispatchEvent(new dom.window.Event("change"));
      expect(document.querySelectorAll(".card")).toHaveLength(0);
      expect(document.querySelector(".hero .hname")?.textContent).toBe(
        "Nothing matches this filter",
      );
    } finally {
      dom.window.close();
    }
  });

  it("combines exact classification filters and rebuilds every derived count", () => {
    const dom = new JSDOM(
      renderDeadlinesWebUi([
        ...workshops,
        {
          id: "future-main",
          name: "Future Main Conference",
          venue_group: "MAIN 2035",
          entry_type: "main_conference",
          archival_status: "archival",
          venue_priority: "primary",
          deadline_label: "paper",
          deadline_aoe: "2035-01-04 23:59:59",
          notification_aoe: null,
          link: "https://conference.example",
          homepage_url: "https://conference.example",
          cfp_url: "",
          openreview_url: "",
          revisions: [],
        },
      ]),
      { runScripts: "dangerously", url: "http://localhost/deadlines" },
    );
    try {
      const document = dom.window.document;
      document.querySelector<HTMLButtonElement>("#v-cards")!.click();
      const entryType = document.querySelector<HTMLSelectElement>("#entry-type")!;
      entryType.value = "workshop";
      entryType.dispatchEvent(new dom.window.Event("change"));

      expect(document.querySelectorAll(".card")).toHaveLength(2);
      expect(document.querySelector("#s-total")?.textContent).toBe("2");
      expect(document.querySelector(".chip .ct")?.textContent).toBe("2");
      expect(document.querySelectorAll(".chip")).toHaveLength(2);

      const priority = document.querySelector<HTMLSelectElement>("#priority")!;
      priority.value = "primary";
      priority.dispatchEvent(new dom.window.Event("change"));

      expect(document.querySelectorAll(".card")).toHaveLength(0);
      expect(document.querySelector("#s-total")?.textContent).toBe("0");
      expect(document.querySelector(".chip .ct")?.textContent).toBe("0");
      expect(document.querySelector("#foot")?.textContent).toContain(
        "Showing 0 of 0 matching upcoming deadlines",
      );
    } finally {
      dom.window.close();
    }
  });
});
