import { describe, expect, it } from "vitest";
import { labCalendarEmbedUrl, resolveLabCalendar } from "./lab-calendar.js";

describe("resolveLabCalendar", () => {
  // A box that configures nothing must still operate on the calendar the lab actually reads,
  // rather than on whatever `primary` happens to be for the bot account.
  it("defaults to the lab's own calendar and timezone", () => {
    const calendar = resolveLabCalendar({});
    expect(calendar.id).toBe("jinesis.lab@gmail.com");
    expect(calendar.timezone).toBe("America/Toronto");
    expect(calendar.embed_url).toBe(
      "https://calendar.google.com/calendar/embed?src=jinesis.lab%40gmail.com&ctz=America%2FToronto",
    );
  });

  it("takes the id and zone from the environment when set", () => {
    const calendar = resolveLabCalendar({
      ADMINBOT_LAB_CALENDAR_ID: "other@example.com",
      ADMINBOT_LAB_CALENDAR_TIMEZONE: "Europe/Zurich",
    });
    expect(calendar.id).toBe("other@example.com");
    expect(calendar.embed_url).toContain("other%40example.com");
    expect(calendar.embed_url).toContain("Europe%2FZurich");
  });

  it("stores an AoE display label as its canonical IANA zone", () => {
    const calendar = resolveLabCalendar({
      ADMINBOT_LAB_CALENDAR_TIMEZONE: "Anywhere on Earth (AoE, UTC−12)",
    });
    expect(calendar.timezone).toBe("Etc/GMT+12");
    expect(calendar.embed_url).toContain("Etc%2FGMT%2B12");
  });
});

describe("labCalendarEmbedUrl", () => {
  it("escapes the id and the zone", () => {
    expect(labCalendarEmbedUrl("a b@example.com", "America/Toronto")).toBe(
      "https://calendar.google.com/calendar/embed?src=a+b%40example.com&ctz=America%2FToronto",
    );
  });
});
