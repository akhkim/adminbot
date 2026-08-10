// Control UI module owns which signed-out surface is on screen, and puts it in the URL.
//
// The landing page, the sign-in gate, and the guest reimbursement tool are overlays on top of
// whatever tab a visitor is on, not tabs of their own. Held as bare component flags they were
// invisible to history, so the browser Back button on the gate left the site instead of returning
// to the landing page. Carrying the surface in a query param makes each one a real history entry
// (and a shareable link) without giving them tab routes they do not otherwise need.

export type SignedOutView = "landing" | "login" | "guest-reimbursements";

const SIGNED_OUT_PARAM = "signedOut";

// The landing page is the default surface, so it is the absent value rather than a spelled-out one.
const VIEW_BY_PARAM: Record<string, SignedOutView> = {
  login: "login",
  reimbursements: "guest-reimbursements",
};
const PARAM_BY_VIEW: Record<SignedOutView, string | null> = {
  landing: null,
  login: "login",
  "guest-reimbursements": "reimbursements",
};

// Structural so both the full view state and the narrower member-auth host satisfy it.
export type SignedOutViewHost = {
  authGateVisible?: boolean;
  guestReimbursements?: boolean;
};

export function signedOutViewFromSearch(search: string): SignedOutView {
  const raw = new URLSearchParams(search).get(SIGNED_OUT_PARAM)?.trim().toLowerCase();
  return (raw && VIEW_BY_PARAM[raw]) || "landing";
}

function applySignedOutView(host: SignedOutViewHost, view: SignedOutView) {
  host.authGateVisible = view === "login";
  host.guestReimbursements = view === "guest-reimbursements";
}

function writeSignedOutViewToUrl(view: SignedOutView, replace: boolean) {
  const href = typeof window === "undefined" ? undefined : window.location?.href;
  const history = typeof window === "undefined" ? undefined : window.history;
  if (!href || !history) {
    return;
  }
  const url = new URL(href);
  const param = PARAM_BY_VIEW[view];
  if (param) {
    url.searchParams.set(SIGNED_OUT_PARAM, param);
  } else {
    url.searchParams.delete(SIGNED_OUT_PARAM);
  }
  if (url.toString() === href) {
    return;
  }
  if (replace) {
    history.replaceState({}, "", url.toString());
    return;
  }
  history.pushState({}, "", url.toString());
}

// Opening or leaving a signed-out surface. Pushes a history entry so Back returns to the previous
// surface; landing is pushed too, so a visitor who opens the gate and closes it in-page can still
// go Forward to it.
export function goToSignedOutView(host: SignedOutViewHost, view: SignedOutView) {
  applySignedOutView(host, view);
  writeSignedOutViewToUrl(view, false);
}

// Boot and popstate: the URL is already the truth, so adopt it without adding an entry.
export function syncSignedOutViewWithLocation(host: SignedOutViewHost) {
  const search = typeof window === "undefined" ? undefined : window.location?.search;
  if (search === undefined) {
    return;
  }
  applySignedOutView(host, signedOutViewFromSearch(search));
}

// Signing out drops the member session; leaving `?signedOut=login` behind would put a visitor back
// on the gate on the next reload instead of the landing page.
export function clearSignedOutView(host: SignedOutViewHost) {
  applySignedOutView(host, "landing");
  writeSignedOutViewToUrl("landing", true);
}
