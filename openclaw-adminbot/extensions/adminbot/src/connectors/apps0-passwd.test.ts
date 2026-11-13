import { describe, expect, it, vi } from "vitest";
import { createApps0PasswdReader, parseApps0PasswdUsernames } from "./apps0-passwd.js";

// Synthetic accounts, enough of them to clear the "this is really the department" floor.
const MANY = Array.from({ length: 150 }, (_, index) => `user${index}`);

describe("parseApps0PasswdUsernames", () => {
  it("takes only the login field of a full passwd line", () => {
    expect(
      parseApps0PasswdUsernames(
        "root:x:0:0:root:/root:/bin/bash\nada:x:1001:1001:Ada Example:/u/ada:/bin/bash\n",
      ),
    ).toEqual(["root", "ada"]);
  });

  it("reads the bare one-per-line names `cut -d: -f1` returns", () => {
    expect(parseApps0PasswdUsernames("luca\nvan\r\nvincent\n")).toEqual(["luca", "van", "vincent"]);
  });

  it("skips blanks, comments, NIS entries and anything that is not a login name", () => {
    expect(parseApps0PasswdUsernames("\n# comment\n+::::::\n-bad\nnot a name\nok\n")).toEqual([
      "ok",
    ]);
  });

  it("lowercases and dedupes", () => {
    expect(parseApps0PasswdUsernames("Ada\nada\n")).toEqual(["ada"]);
  });
});

describe("createApps0PasswdReader", () => {
  it("reads apps0 by default and answers its login names", async () => {
    const run = vi.fn(async () => [...MANY, "luca"].join("\n"));
    const names = await createApps0PasswdReader({ run })();
    expect(run).toHaveBeenCalledWith("apps0.cs.toronto.edu");
    expect(names).toContain("luca");
  });

  it("refuses when ssh fails, rather than treating the namespace as empty", async () => {
    const read = createApps0PasswdReader({
      run: async () => {
        throw new Error("Host key verification failed.");
      },
    });
    await expect(read()).rejects.toThrow(/could not read \/etc\/passwd on apps0.*Host key/u);
  });

  it("refuses an answer too short to be the department's", async () => {
    const read = createApps0PasswdReader({ run: async () => "luca\nvan\n" });
    await expect(read()).rejects.toThrow(/only 2 login names/u);
  });

  it("reuses one read for a minute, then reads again", async () => {
    let clock = 0;
    const run = vi.fn(async () => MANY.join("\n"));
    const read = createApps0PasswdReader({ run, now: () => clock });
    await read();
    clock = 30_000;
    await read();
    expect(run).toHaveBeenCalledTimes(1);
    clock = 61_000;
    await read();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not remember a failure, so the next filing tries again", async () => {
    const run = vi
      .fn<(host: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(MANY.join("\n"));
    const read = createApps0PasswdReader({ run, now: () => 0 });
    await expect(read()).rejects.toThrow(/timeout/u);
    await expect(read()).resolves.toHaveLength(MANY.length);
  });
});
