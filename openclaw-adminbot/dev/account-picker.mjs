// Served exclusively by the opt-in Vite development plugin; absent from production entrypoints.
export async function installAccountPicker({ accounts, password, backendUrl }) {
  await customElements.whenDefined("openclaw-app");
  const app = document.querySelector("openclaw-app");
  if (!app) {
    return;
  }
  await app.updateComplete;
  // Vite prints the plain frontend URL too. A fresh browser should not need the launcher's
  // query parameter, but an explicit backend choice or an existing session must be preserved.
  if (!app.settings?.adminBotUrl?.trim() && !app.memberId && !app.memberAuthBusy) {
    app.applySettings({ ...app.settings, adminBotUrl: backendUrl });
  }
  const panel = document.createElement("aside");
  panel.id = "adminbot-dev-account-picker";
  panel.setAttribute("aria-label", "Local test accounts");
  const root = panel.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { position: fixed; bottom: 20px; right: 20px; z-index: 10000;
        width: min(300px, calc(100vw - 40px)); font: 14px/1.4 system-ui, sans-serif;
        color: #f4f4f5; background: #20232b; border: 1px solid #626978; border-radius: 12px;
        box-shadow: 0 8px 28px #0005; }
      :host([hidden]) { display: none; }
      details { padding: 14px; }
      summary { cursor: pointer; font-weight: 650; }
      p { color: #c4c9d3; margin: 8px 0 12px; font-size: 12px; }
      .accounts { display: grid; gap: 6px; }
      button { text-align: left; padding: 8px 10px; color: inherit; background: #303643;
        border: 1px solid #626978; border-radius: 6px; cursor: pointer; font: inherit; }
      button:hover { background: #424c60; }
      button:disabled { opacity: .5; cursor: default; }
      a { display: block; margin-top: 8px; color: #b7d4ff; }
      a[hidden] { display: none; }
      [role="status"]:empty { display: none; }
    </style>
    <details open>
      <summary>Local test accounts</summary>
      <p>Development only · Choose an account to sign in.</p>
      <div class="accounts"></div>
      <p role="status" aria-live="polite"></p>
    </details>`;
  const status = root.querySelector('[role="status"]');
  const localLink = document.createElement("a");
  const localUrl = new URL(window.location.href);
  localUrl.searchParams.set("adminBotUrl", backendUrl);
  localLink.href = localUrl.href;
  localLink.textContent = "Open the local development backend";
  root.querySelector("details").append(localLink);
  const signOut = document.createElement("button");
  signOut.type = "button";
  signOut.textContent = "Sign out to choose another account";
  const handleSignOut = async () => {
    if (busy || app.settings?.adminBotUrl !== backendUrl) {
      return;
    }
    busy = true;
    update();
    try {
      await app.signOutMember();
      status.textContent = "";
    } catch {
      status.textContent = "Could not sign out. Check the local backend and try again.";
    } finally {
      busy = false;
      update();
    }
  };
  signOut.addEventListener("click", () => void handleSignOut());
  root.querySelector("details").append(signOut);
  const buttons = [];
  let busy = false;
  const update = () => {
    const signedIn = Boolean(app.memberId);
    panel.hidden = signedIn && Boolean(app.connected);
    const local = app.settings?.adminBotUrl === backendUrl;
    for (const button of buttons) {
      button.disabled = busy || app.memberAuthBusy || signedIn || !local;
    }
    signOut.hidden = !signedIn;
    signOut.disabled = busy || !local;
    localLink.hidden = local;
    if (!local) {
      status.textContent =
        "This page is configured for a different backend. Open the local backend to use these accounts.";
    } else if (signedIn && !app.connected) {
      status.textContent =
        "Account signed in. The dashboard still needs a configured OpenClaw gateway connection.";
    }
  };
  for (const account of accounts) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Log in as ${account.name} · ${account.role.replaceAll("_", " ")}`;
    const signIn = async () => {
      if (busy || app.memberAuthBusy || app.memberId || app.settings?.adminBotUrl !== backendUrl) {
        return;
      }
      busy = true;
      status.textContent = "Signing in…";
      update();
      try {
        app.authGateVisible = true;
        app.loginMode = "signin";
        app.memberEmail = account.email;
        app.memberPassword = password;
        // Normal password verification, session creation, and server-side roles still apply.
        await app.submitMemberAuth();
        status.textContent = app.memberId
          ? ""
          : "Login failed. Use the original seed password in ADMINBOT_DEV_PASSWORD and restart dev.sh.";
      } catch {
        status.textContent = "Could not sign in. Check that the local backend is running.";
      } finally {
        app.memberPassword = "";
        busy = false;
        update();
      }
    };
    button.addEventListener("click", () => void signIn());
    buttons.push(button);
    root.querySelector(".accounts").append(button);
  }
  // Reflect normal login/logout without changing the production app's lifecycle.
  new MutationObserver(update).observe(app, { subtree: true, childList: true });
  document.body.append(panel);
  update();
}
