import { describe, expect, it } from "vitest";
import { timezoneForLocation } from "./timezone-for-location.ts";

describe("timezoneForLocation", () => {
  it("returns nothing for a blank or unrecognised location", () => {
    expect(timezoneForLocation("")).toBeNull();
    expect(timezoneForLocation("   ")).toBeNull();
    expect(timezoneForLocation("somewhere nice")).toBeNull();
  });

  it("passes through a location that is already a zone id", () => {
    // Several roster rows carry one, because the sheet's location column was reused for it.
    expect(timezoneForLocation("Europe/London")).toBe("Europe/London");
    expect(timezoneForLocation("america/new_york")).toBe("America/New_York");
  });

  it("resolves a city IANA names directly", () => {
    expect(timezoneForLocation("Toronto")).toBe("America/Toronto");
    expect(timezoneForLocation("Berlin, Germany")).toBe("Europe/Berlin");
    expect(timezoneForLocation("Paris, France")).toBe("Europe/Paris");
    expect(timezoneForLocation("Kigali, Rwanda")).toBe("Africa/Kigali");
    expect(timezoneForLocation("Prague, CZ")).toBe("Europe/Prague");
  });

  it("resolves a city IANA does not name, via the alias table", () => {
    // IANA names one zone per US region, never per city.
    expect(timezoneForLocation("Pittsburgh, PA")).toBe("America/New_York");
    expect(timezoneForLocation("Ann Arbor, MI")).toBe("America/Detroit");
    expect(timezoneForLocation("Bay Area, CA")).toBe("America/Los_Angeles");
    expect(timezoneForLocation("Bengaluru, India")).toBe("Asia/Kolkata");
  });

  it("strips accents and punctuation before matching", () => {
    expect(timezoneForLocation("Zürich")).toBe("Europe/Zurich");
    expect(timezoneForLocation("Zürich, CH")).toBe("Europe/Zurich");
    expect(timezoneForLocation("Tübingen, Germany")).toBe("Europe/Berlin");
    expect(timezoneForLocation("St. Louis")).toBe("America/Chicago");
  });

  it("falls back to the country when no city in the string is known", () => {
    expect(timezoneForLocation("Chandigarh, India")).toBe("Asia/Kolkata");
    expect(timezoneForLocation("Cape Town, South Africa")).toBe("Africa/Johannesburg");
    expect(timezoneForLocation("Islamabad, Pakistan")).toBe("Asia/Karachi");
    expect(timezoneForLocation("Taiwan")).toBe("Asia/Taipei");
  });

  // People write where they are before where they are going, so position in the string decides.
  it("takes the first place mentioned when a location lists several", () => {
    expect(timezoneForLocation("Toronto (soon Berkeley)")).toBe("America/Toronto");
    expect(timezoneForLocation("Zurich/Tuebingen/Toronto")).toBe("Europe/Zurich");
    expect(timezoneForLocation("New York, Zurich")).toBe("America/New_York");
    expect(timezoneForLocation("Warsaw, Poland; Alicante, Spain (starting November)")).toBe(
      "Europe/Warsaw",
    );
    expect(timezoneForLocation("Mainly Montreal (can visit Toronto too, whenever is needed)")).toBe(
      "America/Toronto",
    );
  });

  it("matches on whole words only", () => {
    // "sf" is an alias for San Francisco; it must not fire inside another word.
    expect(timezoneForLocation("Dusseldorf")).toBeNull();
    expect(timezoneForLocation("Berkeley/SF")).toBe("America/Los_Angeles");
  });
});
