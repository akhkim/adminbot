import { afterEach, expect, it, vi } from "vitest";
import { saveStoredMemberSession, clearStoredMemberSession } from "../auth/session.ts";
import { InterviewInvite } from "./interview-invite.ts";

afterEach(() => {
  document.body.replaceChildren();
  clearStoredMemberSession();
  vi.unstubAllGlobals();
});
it("previews and queues a draft without claiming it has been sent", async () => {
  saveStoredMemberSession({ sessionToken: "synthetic-session", expiresAt: "2099-01-01T00:00:00Z" });
  const fetcher = vi.fn(
    async (_url: unknown, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          init?.method === "POST"
            ? JSON.parse(init.body as string).preview
              ? { subject: "Example task", body: "Example preview" }
              : { id: "example-proposal" }
            : { members: [] },
        ),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const element = new InterviewInvite();
  element.members = [
    { id: "one", name: "Example One", slack_user_id: "UONE", privilege_level: "member" },
    { id: "two", name: "Example Two", slack_user_id: "UTWO", privilege_level: "member" },
  ];
  document.body.append(element);
  await element.updateComplete;
  const root = element.shadowRoot!;
  for (const [key, value] of Object.entries({
    name: "Example Candidate",
    email: "candidate@example.com",
    project: "Example",
    task: "Example task",
    first: "UONE",
    second: "UTWO",
  })) {
    (root.querySelector(`[name="${key}"]`) as HTMLInputElement).value = value;
  }
  const form = root.querySelector("form")!;
  const submit = () =>
    form.dispatchEvent(
      new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true,
        submitter: root.querySelector('button[value="preview"]'),
      }),
    );
  submit();
  await vi.waitFor(() => expect(root.textContent).toContain("Example preview"));
  expect(root.querySelector('button[value="queue"]')).not.toBeNull();
  root.querySelector('input[name="project"]')!.dispatchEvent(new Event("input", { bubbles: true }));
  await element.updateComplete;
  expect(root.querySelector('button[value="queue"]')).toBeNull();
  submit();
  await vi.waitFor(() => expect(root.querySelector('button[value="queue"]')).not.toBeNull());
  form.dispatchEvent(
    new SubmitEvent("submit", {
      bubbles: true,
      cancelable: true,
      submitter: root.querySelector('button[value="queue"]'),
    }),
  );
  await vi.waitFor(() => expect(root.textContent).toContain("Nothing has been sent yet"));
  const writes = fetcher.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(init?.body as string));
  expect(writes.map((value) => value.preview)).toEqual([true, true, false]);
});
