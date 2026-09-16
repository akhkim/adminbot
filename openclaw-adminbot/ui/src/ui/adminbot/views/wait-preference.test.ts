import { afterEach, expect, it, vi } from "vitest";
import { taskActivities } from "../task-request.ts";
import { AdminBotWaitPreference } from "./wait-preference.ts";

// A unique subclass avoids stale production registrations in the isolate:false UI lane.
class TestWaitPreference extends AdminBotWaitPreference {}
customElements.define("test-wait-preference", TestWaitPreference);

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const mount = (sessionContext: string, standalone = true) => {
  const element = new TestWaitPreference();
  element.baseUrl = "http://localhost:8765";
  element.sessionContext = sessionContext;
  element.standalone = standalone;
  document.body.append(element);
  return element;
};
const box = (element: HTMLElement) =>
  element.querySelector<HTMLInputElement>('[data-testid="wait-preference-toggle"]');

afterEach(() => {
  document.body.replaceChildren();
  taskActivities.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("reads the member's standing answer with their own credential", async () => {
  const fetcher = vi.fn().mockResolvedValue(json({ inference_always_wait: true }));
  vi.stubGlobal("fetch", fetcher);
  const element = mount("member-token");
  await vi.waitFor(() => expect(box(element)?.checked).toBe(true));
  // The bug this pins: taskFetch adds no Authorization, so an element that does not supply one
  // reads as an anonymous caller and the card never appears for a signed-in member.
  const headers = new Headers(fetcher.mock.calls[0][1].headers);
  expect(fetcher.mock.calls[0][0]).toBe("http://localhost:8765/inference/preferences");
  expect(headers.get("Authorization")).toBe("Bearer member-token");
});

it("renders as a profile card, and renders nothing at all for a visitor", async () => {
  const fetcher = vi.fn().mockResolvedValue(json({ inference_always_wait: false }));
  vi.stubGlobal("fetch", fetcher);
  const member = mount("member-token");
  await vi.waitFor(() => expect(box(member)).not.toBeNull());
  // Light DOM and the page's own section classes: a shadow root leaves the control unstyled
  // inside a host that styles its children.
  expect(member.shadowRoot).toBeNull();
  expect(member.querySelector(".profile__section")).not.toBeNull();
  expect(member.textContent).toContain("Assistant requests");

  const visitor = mount("visitor");
  await vi.waitFor(() => expect(visitor.hasUpdated).toBe(true));
  expect(visitor.children.length).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("writes the new answer, and puts the box back when the write is refused", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ inference_always_wait: false }))
    .mockResolvedValueOnce(json({ inference_always_wait: true }))
    .mockResolvedValueOnce(json({ error: { message: "nope" } }, 500));
  vi.stubGlobal("fetch", fetcher);
  const element = mount("member-token");
  await vi.waitFor(() => expect(box(element)?.checked).toBe(false));

  box(element)!.click();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[1][1].method).toBe("PUT");
  expect(JSON.parse(String(fetcher.mock.calls[1][1].body))).toEqual({
    inference_always_wait: true,
  });
  await vi.waitFor(() => expect(box(element)?.checked).toBe(true));

  box(element)!.click();
  await vi.waitFor(() =>
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("could not be saved"),
  );
  expect(box(element)?.checked).toBe(true);
});
