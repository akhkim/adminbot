import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSignedOutView,
  goToSignedOutView,
  signedOutViewFromSearch,
  syncSignedOutViewWithLocation,
  type SignedOutViewHost,
} from "./signed-out-view.ts";

function createHost(): SignedOutViewHost {
  return { authGateVisible: false, guestReimbursements: false };
}

function currentSearch(): string {
  return new URL(window.location.href).search;
}

describe("signed-out view routing", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/chat");
  });

  it("reads the view from the URL", () => {
    expect(signedOutViewFromSearch("")).toBe("landing");
    expect(signedOutViewFromSearch("?signedOut=login")).toBe("login");
    expect(signedOutViewFromSearch("?signedOut=reimbursements")).toBe("guest-reimbursements");
    expect(signedOutViewFromSearch("?signedOut=nonsense")).toBe("landing");
  });

  // Opening the gate has to add a history entry, or the browser Back button leaves the site
  // instead of returning the visitor to the landing page.
  it("pushes a history entry so Back leaves the gate", () => {
    const host = createHost();
    const before = window.history.length;

    goToSignedOutView(host, "login");

    expect(host.authGateVisible).toBe(true);
    expect(currentSearch()).toBe("?signedOut=login");
    expect(window.history.length).toBe(before + 1);
  });

  it("keeps the path and swaps only the surface", () => {
    const host = createHost();
    window.history.replaceState({}, "", "/adminbot/reimbursements?session=main");

    goToSignedOutView(host, "guest-reimbursements");
    const url = new URL(window.location.href);
    expect(url.pathname).toBe("/adminbot/reimbursements");
    expect(url.searchParams.get("session")).toBe("main");
    expect(url.searchParams.get("signedOut")).toBe("reimbursements");
    expect(host.guestReimbursements).toBe(true);
    expect(host.authGateVisible).toBe(false);
  });

  it("drops the param on sign-out so a reload lands on the landing page", () => {
    const host = createHost();

    goToSignedOutView(host, "login");
    clearSignedOutView(host);

    expect(host.authGateVisible).toBe(false);
    expect(currentSearch()).toBe("");
  });

  it("adopts the view from the URL without adding history entries", () => {
    const host = createHost();
    window.history.replaceState({}, "", "/chat?signedOut=login");
    const before = window.history.length;

    syncSignedOutViewWithLocation(host);

    expect(host.authGateVisible).toBe(true);
    expect(window.history.length).toBe(before);
  });
});
