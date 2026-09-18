import { afterEach, describe, expect, it, vi } from "vitest";
import { installAccountPicker } from "../../../../dev/account-picker.mjs";

class PickerTestApp extends HTMLElement {
  settings = { adminBotUrl: "http://127.0.0.1:8801" };
  updateComplete = Promise.resolve();
  memberId: string | null = null;
  connected = true;
  memberEmail = "";
  memberPassword = "";
  memberAuthBusy = false;
  loginMode = "signup";
  authGateVisible = false;
  applySettings = vi.fn((settings: { adminBotUrl: string }) => {
    this.settings = settings;
  });
  submitMemberAuth = vi.fn(async () => {
    this.memberId = "dev-bob";
  });
  signOutMember = vi.fn(async () => {
    this.memberId = null;
  });
}

customElements.define("picker-test-app", PickerTestApp);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function setup(
  backendUrl = "http://127.0.0.1:8801",
  configure: (app: PickerTestApp) => void = () => {},
) {
  const app = document.createElement("picker-test-app") as PickerTestApp;
  configure(app);
  vi.spyOn(customElements, "whenDefined").mockResolvedValue(PickerTestApp);
  const querySelector = document.querySelector.bind(document);
  vi.spyOn(document, "querySelector").mockImplementation((selector) =>
    selector === "openclaw-app" ? app : querySelector(selector),
  );
  document.body.append(app);
  await installAccountPicker({
    accounts: [{ name: "Bob Example", email: "bob@example.test", role: "member" }],
    password: "Synthetic-test-password!",
    backendUrl,
  });
  const panel = document.querySelector<HTMLElement>("#adminbot-dev-account-picker")!;
  const button = panel.shadowRoot!.querySelector("button")!;
  return { app, panel, button };
}

describe("local account picker", () => {
  it("configures a fresh browser opened at the plain Vite URL and enables login", async () => {
    const { app, button } = await setup(undefined, (host) => {
      host.settings.adminBotUrl = "";
    });
    expect(app.applySettings).toHaveBeenCalledWith({ adminBotUrl: "http://127.0.0.1:8801" });
    expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(() => expect(app.memberId).toBe("dev-bob"));
  });

  it("preserves an explicit backend and offers a local link instead of sending credentials", async () => {
    const { app, panel, button } = await setup(undefined, (host) => {
      host.settings.adminBotUrl = "https://production.example.test";
    });
    expect(app.applySettings).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    button.click();
    expect(app.submitMemberAuth).not.toHaveBeenCalled();
    const link = panel.shadowRoot!.querySelector("a")!;
    expect(link.hidden).toBe(false);
    const url = new URL(link.href);
    expect(url.origin).toBe(window.location.origin);
    expect(url.searchParams.get("adminBotUrl")).toBe("http://127.0.0.1:8801");
  });

  it("does not switch the backend underneath an existing session", async () => {
    const { app, button } = await setup(undefined, (host) => {
      host.settings.adminBotUrl = "";
      host.memberId = "existing-member";
    });
    expect(app.applySettings).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
  });

  it("uses the ordinary login method and hides after signing in; returns on logout", async () => {
    const { app, panel, button } = await setup();
    app.submitMemberAuth.mockImplementation(async () => {
      expect(app.memberEmail).toBe("bob@example.test");
      expect(app.memberPassword).toBe("Synthetic-test-password!");
      expect(app.loginMode).toBe("signin");
      app.memberId = "dev-bob";
    });
    button.click();
    await vi.waitFor(() => expect(panel.hidden).toBe(true));
    expect(app.submitMemberAuth).toHaveBeenCalledOnce();
    expect(app.memberPassword).toBe("");
    app.memberId = null;
    app.append(document.createElement("span"));
    await vi.waitFor(() => expect(panel.hidden).toBe(false));
  });

  it("never sends fixture credentials to a different backend", async () => {
    const { app, button } = await setup("https://production.example.test");
    expect(button.disabled).toBe(true);
    button.click();
    expect(app.submitMemberAuth).not.toHaveBeenCalled();
    // Check the guard again at click time even if settings changed after rendering.
    button.disabled = false;
    button.click();
    expect(app.submitMemberAuth).not.toHaveBeenCalled();
    expect(app.memberPassword).toBe("");
  });

  it("explains a missing gateway and allows signing out after account authentication", async () => {
    const { app, panel, button } = await setup();
    app.connected = false;
    button.click();
    await vi.waitFor(() => expect(app.memberPassword).toBe(""));
    expect(panel.hidden).toBe(false);
    expect(panel.shadowRoot!.querySelector('[role="status"]')!.textContent).toContain("gateway");
    const signOut = [...panel.shadowRoot!.querySelectorAll("button")].find((item) =>
      item.textContent?.startsWith("Sign out"),
    )!;
    signOut.click();
    await vi.waitFor(() => expect(app.memberId).toBe(null));
    expect(app.signOutMember).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(false);
  });

  it("reports rejected credentials without claiming success or retaining the filled password", async () => {
    const { app, panel, button } = await setup();
    app.submitMemberAuth.mockImplementation(async () => {});
    button.click();
    await vi.waitFor(() =>
      expect(panel.shadowRoot!.querySelector('[role="status"]')!.textContent).toContain(
        "Login failed",
      ),
    );
    expect(panel.hidden).toBe(false);
    expect(app.memberPassword).toBe("");
  });
});
