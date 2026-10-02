import { html, nothing } from "lit";
import type { ConferenceRoster } from "../auth/session.ts";
import type { DeadlineVenue } from "../data/deadlines.ts";

// Match recorded aliases and year, never an acronym guessed from a full conference title.
export function conferenceRosterFor(
  venues: readonly DeadlineVenue[],
  rosters: readonly ConferenceRoster[],
) {
  for (const venue of venues) {
    const event = venue.schedule.find((item) => item.milestone === "conference");
    const year = Number(
      (event?.starts ?? event?.date ?? venue.name.match(/\b20\d{2}\b/u)?.[0] ?? "").slice(0, 4),
    );
    if (!year) continue;
    const normalize = (name: string) =>
      name
        .replace(new RegExp(`\\b${year}\\b`, "gu"), "")
        .toLowerCase()
        .replace(/[^a-z0-9]/gu, "");
    const aliases = [venue.venue_family, venue.name, ...venue.venue_aliases]
      .filter((name): name is string => Boolean(name))
      .map(normalize);
    const roster = rosters.find(
      (entry) => entry.year === year && aliases.includes(normalize(entry.venue)),
    );
    if (roster) return roster;
  }
  return undefined;
}

export function renderConferenceAttendance(
  roster: ConferenceRoster,
  busy: boolean,
  notice: string,
  invite: () => void,
) {
  const labels = { yes: "Going", no: "Not going", unknown: "Not confirmed" };
  const venue = roster.venue
    .replace(new RegExp(`\\b${roster.year}\\b`, "gu"), "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return html`<section
    class="deadline-conference-attendance"
    aria-label=${`${roster.label} attendance`}
  >
    ${(["yes", "unknown", "no"] as const).map((state) => {
      const people = roster.people.filter((person) => person.attending === state);
      return people.length
        ? html`<div>
            <strong>${labels[state]}</strong>
            <ul class="deadline-conference-people">
              ${people.map(
                (person) => html`<li title=${person.papers.map((paper) => paper.title).join(" · ")}>
                  ${person.avatar_url?.startsWith("https://")
                    ? html`<img
                        src=${person.avatar_url}
                        alt=""
                        width="28"
                        height="28"
                        referrerpolicy="no-referrer"
                      />`
                    : html`<span class="deadline-conference-initials" aria-hidden="true"
                        >${person.name
                          .split(/\s+/u)
                          .map((word) => word[0])
                          .slice(0, 2)
                          .join("")}</span
                      >`}
                  <span>${person.name}</span>
                </li>`,
              )}
            </ul>
          </div>`
        : nothing;
    })}
    ${roster.going_count
      ? html`<button class="btn" type="button" ?disabled=${busy} @click=${invite}>
          ${busy ? "Adding…" : `Add going authors to #conf-${venue}-${roster.year}`}
        </button>`
      : nothing}
    ${notice ? html`<p role="status">${notice}</p>` : nothing}
  </section>`;
}
