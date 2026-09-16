// Which hosts count as Overleaf here, and what a link is allowed to become.
import { describe, expect, it } from "vitest";
import {
  ADMINBOT_LAB_OVERLEAF_HOST,
  ADMINBOT_OVERLEAF_URL_ENV,
  adminBotOverleafHosts,
  adminBotOverleafProjectRef,
  isAdminBotOverleafHost,
  resolveAdminBotLabOverleafHost,
} from "./overleaf.js";

describe("resolveAdminBotLabOverleafHost", () => {
  it("is the lab's own instance when nothing is configured", () => {
    expect(resolveAdminBotLabOverleafHost({})).toBe(ADMINBOT_LAB_OVERLEAF_HOST);
  });

  it("takes a configured origin or a bare hostname", () => {
    expect(
      resolveAdminBotLabOverleafHost({ [ADMINBOT_OVERLEAF_URL_ENV]: "https://tex.example.edu/" }),
    ).toBe("tex.example.edu");
    expect(resolveAdminBotLabOverleafHost({ [ADMINBOT_OVERLEAF_URL_ENV]: "tex.example.edu" })).toBe(
      "tex.example.edu",
    );
  });

  it("falls back rather than resolving to nothing when the value is junk", () => {
    expect(resolveAdminBotLabOverleafHost({ [ADMINBOT_OVERLEAF_URL_ENV]: "   " })).toBe(
      ADMINBOT_LAB_OVERLEAF_HOST,
    );
  });
});

describe("adminBotOverleafHosts", () => {
  it("always keeps overleaf.com: a configured instance does not end collaboration", () => {
    expect(adminBotOverleafHosts({ [ADMINBOT_OVERLEAF_URL_ENV]: "tex.example.edu" })).toEqual([
      "overleaf.com",
      "tex.example.edu",
    ]);
  });

  it("lists it once when the deployment's instance is overleaf.com itself", () => {
    expect(adminBotOverleafHosts({ [ADMINBOT_OVERLEAF_URL_ENV]: "overleaf.com" })).toEqual([
      "overleaf.com",
    ]);
  });

  it("counts subdomains as the same place", () => {
    expect(isAdminBotOverleafHost("www.overleaf.com", {})).toBe(true);
    expect(isAdminBotOverleafHost(`tex.${ADMINBOT_LAB_OVERLEAF_HOST}`, {})).toBe(true);
    expect(isAdminBotOverleafHost("overleaf.com.evil.example", {})).toBe(false);
  });
});

describe("adminBotOverleafProjectRef", () => {
  it("reads the project id off a lab link and says it is one PaperMentor can see", () => {
    expect(
      adminBotOverleafProjectRef(
        `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/65f2a1c9d4e3b7a801f6`,
        {},
      ),
    ).toEqual({
      projectId: "65f2a1c9d4e3b7a801f6",
      origin: `https://${ADMINBOT_LAB_OVERLEAF_HOST}`,
      host: ADMINBOT_LAB_OVERLEAF_HOST,
      lab: true,
    });
  });

  it("reads an overleaf.com link too, and marks it as one PaperMentor cannot", () => {
    expect(
      adminBotOverleafProjectRef("https://www.overleaf.com/project/65f2a1c9d4e3b7a801f6", {}),
    ).toMatchObject({ projectId: "65f2a1c9d4e3b7a801f6", lab: false });
  });

  it("survives the trailing path Overleaf adds while you are editing", () => {
    expect(
      adminBotOverleafProjectRef(
        `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/65f2a1c9d4e3b7a801f6/detacher`,
        {},
      ),
    ).toMatchObject({ projectId: "65f2a1c9d4e3b7a801f6" });
  });

  it("refuses anything that is not a project on an Overleaf we know", () => {
    const cases = [
      // Not one of ours -- the whole point of the check.
      "https://evil.example/project/65f2a1c9d4e3b7a801f6",
      // Right host, wrong kind of link: a share token is not a project id.
      `https://${ADMINBOT_LAB_OVERLEAF_HOST}/read/xzqvbnmklpqr`,
      // Right host and path, an id nothing would accept.
      `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/../../etc/passwd`,
      `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/`,
      // http, so a man in the middle picks the project.
      `http://${ADMINBOT_LAB_OVERLEAF_HOST}/project/65f2a1c9d4e3b7a801f6`,
      "not a url at all",
    ];
    for (const raw of cases) {
      expect(adminBotOverleafProjectRef(raw, {})).toBeUndefined();
    }
  });

  it("follows the configured instance when a deployment names its own", () => {
    const env = { [ADMINBOT_OVERLEAF_URL_ENV]: "https://tex.example.edu" };
    expect(
      adminBotOverleafProjectRef("https://tex.example.edu/project/65f2a1c9d4e3b7a801f6", env),
    ).toMatchObject({ lab: true });
    // The lab's default host is not special once a deployment has named a different one.
    expect(
      adminBotOverleafProjectRef(
        `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/65f2a1c9d4e3b7a801f6`,
        env,
      ),
    ).toBeUndefined();
  });
});
