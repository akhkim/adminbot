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
});
