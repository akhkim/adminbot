import { afterEach, expect, it, vi } from "vitest";
import { canAccessTab } from "../access.ts";
import { type TalkLeaderboard, TalkLeaderboardView } from "./talk-leaderboard.ts";
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const YEAR = new Date().getFullYear();

function board(rows: TalkLeaderboard["rows"], unscanned: string[] = []): TalkLeaderboard {
  return { year: YEAR, rows, unscanned };
}

async function mount(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  const el = new TalkLeaderboardView();
  el.baseUrl = "http://localhost:8765/";
  el.sessionToken = "synthetic";
  el.memberId = "m-cy";
  document.body.append(el);
  await el.updateComplete;
  await vi.waitFor(() => expect(el.shadowRoot!.textContent).not.toContain("Loading…"));
  await el.updateComplete;
  return { el, fetchMock };
}

it("is a member tab, not admin-only", () => {
  expect(canAccessTab("adminbotTalkLeaderboard", "member")).toBe(true);
  expect(canAccessTab("adminbotTalkLeaderboard", "anonymous")).toBe(false);
});

it("asks for this year's board and marks both members tied in the top two, and the viewer", async () => {
  const { el, fetchMock } = await mount(
    Response.json(
      board(
        [
          { rank: 1, member_id: "m-ada", member_name: "Ada", invited: 2, total: 3 },
          { rank: 2, member_id: "m-ben", member_name: "Ben", invited: 1, total: 1 },
          { rank: 2, member_id: "m-cy", member_name: "Cy", invited: 1, total: 1 },
          { rank: 4, member_id: "m-dee", member_name: "Dee", invited: 0, total: 2 },
        ],
        ["Eve"],
      ),
    ),
  );
  expect(fetchMock).toHaveBeenCalledWith(
    `http://localhost:8765/cv/talk-leaderboard?year=${YEAR}`,
    expect.anything(),
  );
  const rows = [...el.shadowRoot!.querySelectorAll("tbody tr")];
  expect(rows.map((row) => row.querySelector(".rank")?.textContent)).toEqual(["1", "2", "2", "4"]);
  expect(rows.map((row) => Boolean(row.querySelector(".pill")))).toEqual([
    true,
    true,
    true,
    false,
  ]);
  expect(rows[2]?.classList.contains("you")).toBe(true);
  expect(rows[2]?.textContent).toContain("Cy (you)");
  expect(rows[0]?.querySelector(".other")?.textContent).toBe("1");
  expect(
    el.shadowRoot!.querySelector('[data-testid="talk-leaderboard-unscanned"]')?.textContent,
  ).toContain("Eve");
});

it("says the year is empty rather than drawing an empty table", async () => {
  const { el } = await mount(Response.json(board([])));
  expect(el.shadowRoot!.querySelector("table")).toBeNull();
  expect(
    el.shadowRoot!.querySelector('[data-testid="talk-leaderboard-empty"]')?.textContent,
  ).toContain(`No talks dated ${YEAR}`);
});

it("shows the service's refusal instead of a blank page", async () => {
  const { el } = await mount(
    Response.json({ error: { message: "member session required" } }, { status: 401 }),
  );
  expect(el.shadowRoot!.querySelector('[role="alert"]')?.textContent).toBe(
    "member session required",
  );
});
