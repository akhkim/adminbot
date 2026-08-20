// "Your recent sign-ins are coming from Germany — have you moved?"
//
// The one place an inferred location can turn into a stored one, and it does so only by asking.
// Everything about the shape of this banner follows from that: it quotes the evidence rather than
// asserting a conclusion, both answers are one click, and "no" is as easy as "yes" — a prompt that
// makes dismissal harder is a prompt that collects agreement rather than information.
//
// It renders above the profile form so the member can see the fields it is offering to change.
import { html, nothing } from "lit";
import { timezoneForLocation } from "../data/timezone-for-location.ts";
import type { LocationDrift } from "../auth/session.ts";

export type LocationPromptProps = {
  drift: LocationDrift | null;
  saving: boolean;
  error: string | null;
  onConfirm: (answer: { current_city: string; timezone?: string }) => void;
  onDismiss: () => void;
};

function sinceText(since: string): string {
  const parsed = new Date(since);
  return Number.isNaN(parsed.getTime())
    ? since
    : parsed.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function renderLocationPrompt(props: LocationPromptProps) {
  const drift = props.drift;
  if (!drift) {
    return nothing;
  }
  const place = drift.observed_label ?? drift.observed_country;
  const submit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const value = form.querySelector<HTMLInputElement>("[name=current_city]")?.value.trim();
    if (!value) {
      return;
    }
    // The same guess the profile form makes from a typed location, so confirming a move sets the
    // timezone too. Without it the roster would say Berlin and schedule Toronto, which is the exact
    // failure this whole path exists to prevent.
    const timezone = timezoneForLocation(value);
    props.onConfirm({ current_city: value, ...(timezone ? { timezone } : {}) });
  };
  return html`
    <section class="card adminbot-card adminbot-card--wide location-prompt">
      <div class="card-title">Have you moved?</div>
      <p class="card-sub">
        ${drift.observation_count} sign-ins since ${sinceText(drift.since)} came from
        ${drift.observed_country}${drift.profile_location
          ? html`, but your profile says ${drift.profile_location}`
          : nothing}. Meeting times and calendar invites are scheduled from what your profile says.
      </p>
      ${props.error ? html`<p class="notice notice--error">${props.error}</p>` : nothing}
      <form class="location-prompt__form" @submit=${submit}>
        <label class="location-prompt__field">
          <span>Where you are now</span>
          <input name="current_city" .value=${place} ?disabled=${props.saving} />
        </label>
        <div class="location-prompt__actions">
          <button class="btn btn--sm" type="submit" ?disabled=${props.saving}>
            Yes, update my profile
          </button>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${props.saving}
            @click=${() => props.onDismiss()}
          >
            No, I am still in ${drift.profile_location ?? drift.profile_country ?? "the same place"}
          </button>
        </div>
      </form>
      <!-- Said plainly: a member should know their sign-in country is observed at all, and where
           the claim on screen came from. -->
      <p class="muted location-prompt__note">
        Inferred from the country of your recent sign-ins. It is never written to your profile
        unless you say so here.
      </p>
    </section>
  `;
}
