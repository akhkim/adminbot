// The "where you are" card on the Time Availability tab, cut out of time-availability.ts.
//
// It sits here rather than on the profile form because of what it is for. A member's *profile*
// location is where they live, edited once and then forgotten; this is where they are for the next
// few weeks, and it belongs beside the rest of what they tell the lab about their availability —
// the same page where they say they are away in August or teaching on Tuesdays. Somebody updating
// their schedule for a term abroad is already on this screen.
//
// It is the manual counterpart to the sign-in inference: the same two fields the "have you moved?"
// banner writes, offered without waiting to be asked. A member who knows they are moving on Monday
// can say so on Monday rather than after three days of sign-ins from somewhere else.
import { html, nothing } from "lit";
import { resolveAttendeeZone } from "../data/attendee-time.ts";
import { timezoneForLocation } from "../data/timezone-for-location.ts";

export type WhereYouAreProps = {
  /** The member whose schedule is on screen — not necessarily the viewer. */
  member: { name?: string | null; location?: string | null; current_city?: string | null; timezone?: string | null } | undefined;
  /** Self only. An admin reading someone else's schedule sees the card and cannot edit it. */
  editable: boolean;
  saving: boolean;
  error: string | null;
  onSave: (answer: { current_city: string; timezone?: string }) => void;
};

export function renderWhereYouAre(props: WhereYouAreProps) {
  const member = props.member;
  if (!member) {
    return nothing;
  }
  const zone = resolveAttendeeZone(member);
  const submit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const city = form.querySelector<HTMLInputElement>("[name=current_city]")?.value.trim();
    if (!city) {
      return;
    }
    const typedZone = form.querySelector<HTMLInputElement>("[name=timezone]")?.value.trim();
    // The typed zone wins when there is one: the guess is a convenience, and a member who
    // corrected it has said something more specific than the city did.
    const timezone = typedZone || timezoneForLocation(city) || "";
    props.onSave({ current_city: city, ...(timezone ? { timezone } : {}) });
  };
  return html`
    <section class="card adminbot-card adminbot-card--wide where-you-are">
      <div class="card-title">Where you are</div>
      <p class="card-sub">
        Meetings and calendar invites are scheduled from this. Change it for a trip, an internship
        or a term abroad — it is separate from the home address on your profile${member.location
          ? html` (${member.location})`
          : nothing}.
      </p>
      ${props.error ? html`<p class="notice notice--error">${props.error}</p>` : nothing}
      ${props.editable
        ? html`
            <form class="where-you-are__form" @submit=${submit}>
              <label class="where-you-are__field">
                <span>City</span>
                <input
                  name="current_city"
                  .value=${member.current_city ?? ""}
                  placeholder=${member.location ?? "Toronto"}
                  ?disabled=${props.saving}
                  @input=${(event: Event) => {
                    // Fill the zone from the city as it is typed, but never overwrite a value the
                    // member put there themselves — the guess is a starting point, not a correction.
                    const form = (event.target as HTMLElement).closest("form");
                    const zoneField = form?.querySelector<HTMLInputElement>("[name=timezone]");
                    const guess = timezoneForLocation((event.target as HTMLInputElement).value);
                    if (zoneField && guess && !zoneField.dataset.touched) {
                      zoneField.value = guess;
                    }
                  }}
                />
              </label>
              <label class="where-you-are__field">
                <span>Time zone</span>
                <input
                  name="timezone"
                  .value=${member.timezone ?? ""}
                  placeholder="America/Toronto"
                  ?disabled=${props.saving}
                  @input=${(event: Event) => {
                    (event.target as HTMLInputElement).dataset.touched = "1";
                  }}
                />
              </label>
              <button class="btn btn--sm" type="submit" ?disabled=${props.saving}>
                ${props.saving ? "Saving…" : "Save"}
              </button>
            </form>
          `
        : html`<p class="where-you-are__readonly">
            ${member.current_city ?? member.location ?? "Not stated"}
            ${zone ? html`<span class="muted"> · ${zone.zone}</span>` : nothing}
          </p>`}
      ${props.editable && zone
        ? html`<p class="muted where-you-are__note">
            Scheduling currently uses ${zone.zone}, from your
            ${zone.source === "timezone"
              ? "time zone"
              : zone.source === "current_city"
                ? "current city"
                : "home location"}.
          </p>`
        : nothing}
    </section>
  `;
}
