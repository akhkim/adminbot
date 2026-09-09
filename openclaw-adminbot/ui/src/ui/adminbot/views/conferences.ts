// Conference Overview: what is coming up, what each venue is, and a way to say you are going.
//
// Three readers on one page, and the page changes shape for each because the service already
// decided what each may see. A visitor gets the cards -- these are public venues and the facts
// come from the same deadline dataset the board publishes unauthenticated. A signed-in member
// additionally gets a sign-up form, filled in with whatever they said last time. An admin
// additionally gets the roster: who is going, what they asked the lab to pay for, and the two
// numbers somebody has to have before booking anything -- how many beds, and which nights.
//
// The form asks six things and every one of them is a question only the member can answer. That
// is the test used to decide what belongs here: the lab cannot work out from any record whether
// somebody already has funding from their own scholarship, whether they are staying with family,
// or whether they need a visa letter with six weeks' lead time. Anything derivable was left off.

import { html, nothing } from "lit";
import { icons } from "../../icons.ts";
import type {
  ConferenceFundingNeed,
  ConferenceSummary,
  ConferenceTrip,
  ConferenceTripIntent,
} from "../auth/session.ts";

export type ConferenceTripDraft = {
  intent: ConferenceTripIntent;
  funding: ConferenceFundingNeed;
  needs_lodging: boolean;
  needs_visa_letter: boolean;
  arrival_on: string;
  departure_on: string;
  paper_id: string;
  notes: string;
};

export type ConferencesProps = {
  conferences: ConferenceSummary[];
  /** The viewer's own trips, by conference key. */
  mine: Record<string, ConferenceTrip>;
  /** In-progress edits, by conference key. Absent means "show what is stored". */
  drafts: Record<string, ConferenceTripDraft>;
  /** The viewer's own papers, to name what they are presenting. */
  papers: Array<{ id: string; title: string }>;
  signedIn: boolean;
  savingKey: string | null;
  error: string | null;
  notice: string | null;
  onEdit: (conferenceKey: string, patch: Partial<ConferenceTripDraft>) => void;
  onSave: (conferenceKey: string) => void;
};

const INTENT_LABELS: Record<ConferenceTripIntent, string> = {
  going: "I'm going in person",
  not_going: "I'm not going",
  undecided: "Still deciding",
};

/**
 * The four funding buckets, in what they cost the lab.
 *
 * "No financial aid needed" is offered explicitly rather than left as the blank default: somebody
 * funded by their own scholarship and somebody who has not answered look identical otherwise, and
 * the difference between them is a plane ticket.
 */
const FUNDING_LABELS: Record<ConferenceFundingNeed, string> = {
  none: "No financial aid needed",
  fee_only: "Conference fee only",
  flight_only: "Flight only",
  full_travel: "Full travel (fee, flights and accommodation)",
};

/** AoE dates arrive as "2026-10-01 23:59:59"; the time is noise on a card. */
function dateOnly(value: string | undefined): string {
  return value ? (value.split(" ")[0] ?? value) : "";
}

function draftFrom(trip: ConferenceTrip | undefined): ConferenceTripDraft {
  return {
    // Undecided rather than going: a form that opens on "yes" collects agreement rather than
    // an answer, and this one books flights.
    intent: trip?.intent ?? "undecided",
    funding: trip?.funding ?? "none",
    needs_lodging: trip?.needs_lodging ?? false,
    needs_visa_letter: trip?.needs_visa_letter ?? false,
    arrival_on: trip?.arrival_on ?? "",
    departure_on: trip?.departure_on ?? "",
    paper_id: trip?.paper_id ?? "",
    notes: trip?.notes ?? "",
  };
}

export function renderConferences(props: ConferencesProps) {
  return html`
    <section class="adminbot-shell conferences" data-testid="adminbot-conferences">
      <div class="card adminbot-card adminbot-card--wide">
        <div class="card-title">Conferences</div>
        <div class="card-sub">
          The venues the lab has deadlines against, and a place to say whether you are going. What
          you record here is what the lab books against — headcount, nights and who needs what
          covered.
        </div>
      </div>
      ${props.error
        ? html`<div
            class="card adminbot-card adminbot-card--wide adminbot-notice adminbot-notice--error"
            data-testid="conferences-error"
          >
            ${props.error}
          </div>`
        : nothing}
      ${props.notice
        ? html`<div
            class="card adminbot-card adminbot-card--wide adminbot-notice"
            data-testid="conferences-notice"
          >
            ${props.notice}
          </div>`
        : nothing}
      ${props.conferences.length === 0
        ? html`<div class="card adminbot-card adminbot-card--wide">
            <p class="conferences__empty">
              No upcoming conferences on file. The deadline dataset is where these come from.
            </p>
          </div>`
        : props.conferences.map((conference) => renderConference(props, conference))}
    </section>
  `;
}

function renderConference(props: ConferencesProps, conference: ConferenceSummary) {
  return html`
    <article
      class="card adminbot-card adminbot-card--wide conferences__card"
      data-testid=${`conference-${conference.key}`}
    >
      <div class="conferences__head">
        <div>
          <div class="card-title">${conference.label}</div>
          ${conference.location
            ? html`<div class="conferences__where">
                <span aria-hidden="true">${icons.globe}</span> ${conference.location}
              </div>`
            : nothing}
        </div>
        ${conference.homepage_url
          ? html`<a
              class="btn btn--sm"
              href=${conference.homepage_url}
              target="_blank"
              rel="noreferrer noopener"
              >Homepage</a
            >`
          : nothing}
      </div>
      <p class="conferences__description">${conference.description}</p>
      <div class="conferences__facts">
        <span
          >${conference.workshop_count} workshop${conference.workshop_count === 1 ? "" : "s"}</span
        >
        ${conference.next_deadline_aoe
          ? html`<span
              >Next call closes
              ${dateOnly(conference.next_deadline_aoe)}${conference.next_deadline_label
                ? ` — ${conference.next_deadline_label}`
                : ""}</span
            >`
          : html`<span>No open workshop calls left</span>`}
      </div>
      ${props.signedIn
        ? renderSignup(props, conference)
        : html`<p class="conferences__signed-out">Sign in to say whether you are going.</p>`}
      ${conference.roster ? renderRoster(conference) : nothing}
    </article>
  `;
}

function renderSignup(props: ConferencesProps, conference: ConferenceSummary) {
  const draft = props.drafts[conference.key] ?? draftFrom(props.mine[conference.key]);
  const saving = props.savingKey === conference.key;
  const edit = (patch: Partial<ConferenceTripDraft>) => props.onEdit(conference.key, patch);
  // Everything past "am I going" is a question about a trip that is happening. Asking somebody who
  // just said no how many nights they need is the form arguing with them.
  const going = draft.intent === "going";
  return html`
    <form
      class="adminbot-form conferences__signup"
      data-testid=${`conference-signup-${conference.key}`}
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        props.onSave(conference.key);
      }}
    >
      <label class="adminbot-form__field">
        <span>Are you going?</span>
        <select
          class="input"
          data-testid=${`conference-intent-${conference.key}`}
          @change=${(event: Event) =>
            edit({ intent: (event.target as HTMLSelectElement).value as ConferenceTripIntent })}
        >
          ${(Object.keys(INTENT_LABELS) as ConferenceTripIntent[]).map(
            (value) => html`<option value=${value} ?selected=${value === draft.intent}>
              ${INTENT_LABELS[value]}
            </option>`,
          )}
        </select>
      </label>

      ${going
        ? html`
            <label class="adminbot-form__field">
              <span>What do you need the lab to cover?</span>
              <select
                class="input"
                data-testid=${`conference-funding-${conference.key}`}
                @change=${(event: Event) =>
                  edit({
                    funding: (event.target as HTMLSelectElement).value as ConferenceFundingNeed,
                  })}
              >
                ${(Object.keys(FUNDING_LABELS) as ConferenceFundingNeed[]).map(
                  (value) => html`<option value=${value} ?selected=${value === draft.funding}>
                    ${FUNDING_LABELS[value]}
                  </option>`,
                )}
              </select>
            </label>

            <label class="adminbot-form__field">
              <span>Which paper are you presenting?</span>
              <select
                class="input"
                data-testid=${`conference-paper-${conference.key}`}
                @change=${(event: Event) =>
                  edit({ paper_id: (event.target as HTMLSelectElement).value })}
              >
                <option value="" ?selected=${!draft.paper_id}>Not presenting</option>
                ${props.papers.map(
                  (paper) => html`<option
                    value=${paper.id}
                    ?selected=${paper.id === draft.paper_id}
                  >
                    ${paper.title}
                  </option>`,
                )}
              </select>
            </label>

            <label class="adminbot-form__field conferences__check">
              <input
                type="checkbox"
                data-testid=${`conference-lodging-${conference.key}`}
                .checked=${draft.needs_lodging}
                @change=${(event: Event) =>
                  edit({ needs_lodging: (event.target as HTMLInputElement).checked })}
              />
              <span
                >I want a bed in whatever the lab books
                <small
                  >Asked separately from funding: you might need no money and still want to stay
                  with everyone.</small
                ></span
              >
            </label>

            ${draft.needs_lodging
              ? html`
                  <!-- Both dates, because a headcount alone books the wrong thing: the lab needs
                       to know how many beds *and* for which nights. -->
                  <label class="adminbot-form__field">
                    <span>Arriving</span>
                    <input
                      class="input"
                      type="date"
                      data-testid=${`conference-arrival-${conference.key}`}
                      .value=${draft.arrival_on}
                      @input=${(event: Event) =>
                        edit({ arrival_on: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label class="adminbot-form__field">
                    <span>Leaving</span>
                    <input
                      class="input"
                      type="date"
                      data-testid=${`conference-departure-${conference.key}`}
                      .value=${draft.departure_on}
                      @input=${(event: Event) =>
                        edit({ departure_on: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                `
              : nothing}

            <label class="adminbot-form__field conferences__check">
              <input
                type="checkbox"
                data-testid=${`conference-visa-${conference.key}`}
                .checked=${draft.needs_visa_letter}
                @change=${(event: Event) =>
                  edit({ needs_visa_letter: (event.target as HTMLInputElement).checked })}
              />
              <span
                >I need a visa invitation letter
                <small>Say so early — these take weeks to arrange.</small></span
              >
            </label>

            <label class="adminbot-form__field conferences__notes">
              <span>Anything else</span>
              <textarea
                class="input"
                rows="2"
                placeholder="Arriving early for a workshop, sharing a room, funded by my scholarship…"
                data-testid=${`conference-notes-${conference.key}`}
                .value=${draft.notes}
                @input=${(event: Event) =>
                  edit({ notes: (event.target as HTMLTextAreaElement).value })}
              ></textarea>
            </label>
          `
        : nothing}

      <div class="conferences__actions">
        <button
          type="submit"
          class="btn primary"
          ?disabled=${saving}
          data-testid=${`conference-save-${conference.key}`}
        >
          ${saving ? "Saving…" : props.mine[conference.key] ? "Update" : "Sign up"}
        </button>
        ${props.mine[conference.key]
          ? html`<span class="conferences__saved">Your answer is recorded.</span>`
          : nothing}
      </div>
    </form>
  `;
}

/**
 * The admin half: what the lab has taken on, and the two numbers a booking needs.
 *
 * Lodging is stated first and on its own line because it is the one thing here with a deadline of
 * its own -- the beds have to be booked, and the headcount is useless without the nights.
 */
function renderRoster(conference: ConferenceSummary) {
  const roster = conference.roster;
  if (!roster) {
    return nothing;
  }
  return html`
    <div class="conferences__roster" data-testid=${`conference-roster-${conference.key}`}>
      <h4 class="conferences__roster-title">Who is going</h4>
      <p class="conferences__counts">
        <strong>${roster.going}</strong> going · ${roster.undecided} undecided · ${roster.not_going}
        not going
        ${roster.visa_letters > 0
          ? html`· <span class="conferences__flag">${roster.visa_letters} need a visa letter</span>`
          : nothing}
      </p>
      <p class="conferences__lodging" data-testid=${`conference-lodging-need-${conference.key}`}>
        <span aria-hidden="true">${icons.bookmark}</span>
        ${roster.lodging.guests === 0
          ? "Nobody has asked for a bed yet."
          : html`Book for <strong>${roster.lodging.guests}</strong>${roster.lodging.first_night
                ? html`, ${roster.lodging.first_night} to
                  ${roster.lodging.last_night ?? "an unstated date"}`
                : ", dates not yet given"}`}
      </p>
      <p class="conferences__funding">
        ${(Object.keys(FUNDING_LABELS) as ConferenceFundingNeed[])
          .filter((need) => roster.funding[need] > 0)
          .map((need) => `${roster.funding[need]} × ${FUNDING_LABELS[need]}`)
          .join(" · ") || "No funding asks yet."}
      </p>
      ${roster.trips.length
        ? html`<ul class="conferences__trips">
            ${roster.trips.map(
              (trip) => html`
                <li data-testid=${`conference-trip-${conference.key}-${trip.member_id}`}>
                  <strong>${trip.member_name}</strong>
                  <span>${INTENT_LABELS[trip.intent]}</span>
                  ${trip.intent === "going"
                    ? html`<span>${FUNDING_LABELS[trip.funding]}</span> ${trip.needs_lodging
                          ? html`<span
                              >bed ${trip.arrival_on ?? "?"}–${trip.departure_on ?? "?"}</span
                            >`
                          : nothing}
                        ${trip.paper_title
                          ? html`<span>presenting ${trip.paper_title}</span>`
                          : nothing}
                        ${trip.needs_visa_letter ? html`<span>visa letter</span>` : nothing}`
                    : nothing}
                  ${trip.notes
                    ? html`<span class="conferences__trip-note">${trip.notes}</span>`
                    : nothing}
                </li>
              `,
            )}
          </ul>`
        : nothing}
    </div>
  `;
}
