// What each author did on this paper this week.
//
// The rest of the card records artifacts, and every one of them is a thing that either exists or
// does not. None of them answer what a coauthor actually asks on a Monday -- what moved last week,
// and who moved it. That answer is prose, it is per person, and it is only worth anything written
// while the week is still fresh, which is why the box for this week sits at the top and the log
// underneath it is read-only.
//
// One box, not a thread. A member writes their own line and nobody else's (the service takes the
// author from the session), so there is nothing here to reply to -- the log is a column of
// first-hand accounts, not a discussion.
import { html, nothing } from "lit";
import {
  adminBotFormatWeek,
  adminBotWeeklyUpdateBodyMax,
  adminBotWeekStart,
} from "../../../../../extensions/adminbot/src/contracts/paper-weekly-updates.js";
import { icons } from "../../icons.ts";
import type { PaperWeeklyUpdate } from "../auth/session.ts";

export type PaperWeeklyUpdatesProps = {
  paperId: string;
  updates: PaperWeeklyUpdate[];
  /** The signed-in member, so their own box is the editable one. Absent for a read-only viewer. */
  memberId?: string;
  /** Roster names by id, for the log. An id nobody can resolve is shown as the id. */
  memberNames?: Record<string, string>;
  /** Absent for a reader who may not write here (not an author, or no session). */
  onSave?: (body: string) => void;
  busy?: boolean;
  /** Fixed "now" for tests. Real callers leave it out. */
  now?: Date;
};

/** How many past weeks the log shows before it stops. Enough for a month of context. */
const VISIBLE_WEEKS = 4;

function weekGroups(updates: PaperWeeklyUpdate[]): Array<[string, PaperWeeklyUpdate[]]> {
  const byWeek = new Map<string, PaperWeeklyUpdate[]>();
  for (const update of updates) {
    byWeek.set(update.week_start, [...(byWeek.get(update.week_start) ?? []), update]);
  }
  return [...byWeek].toSorted(([left], [right]) => right.localeCompare(left));
}

function nameFor(props: PaperWeeklyUpdatesProps, memberId: string): string {
  return props.memberNames?.[memberId] ?? memberId;
}

export function renderPaperWeeklyUpdates(props: PaperWeeklyUpdatesProps) {
  const thisWeek = adminBotWeekStart(props.now ?? new Date());
  const own = props.memberId
    ? props.updates.find(
        (update) => update.member_id === props.memberId && update.week_start === thisWeek,
      )
    : undefined;
  // Everyone else's entries for this week, then the weeks before it. The member's own line for
  // this week is the box above, so showing it twice would read as two different records.
  const groups = weekGroups(
    props.updates.filter(
      (update) => !(update.week_start === thisWeek && update.member_id === props.memberId),
    ),
  ).slice(0, VISIBLE_WEEKS);

  return html`
    <details class="weekly-updates" open data-testid=${`paper-weekly-updates-${props.paperId}`}>
      <summary class="paper-slots__group-head">
        <h4 class="weekly-updates__title">
          <span class="weekly-updates__icon" aria-hidden="true">${icons.activity}</span>
          Weekly updates
        </h4>
        <span class="weekly-updates__week">${adminBotFormatWeek(thisWeek)}</span>
        <span class="paper-slots__group-chevron" aria-hidden="true">${icons.chevronDown}</span>
      </summary>
      ${props.onSave
        ? html`
            <label class="weekly-updates__own">
              <span class="weekly-updates__own-label">
                What did you do on this paper during ${adminBotFormatWeek(thisWeek)}?
              </span>
              <span class="weekly-updates__own-sub">
                One entry per paper, per week, written by you. Your coauthors and the lab read it;
                it is not sent to anyone as a message.
              </span>
              <textarea
                class="input weekly-updates__box"
                rows="3"
                maxlength=${adminBotWeeklyUpdateBodyMax}
                placeholder="Ran the ablation on the 7B model and wrote it up in §5. Blocked on the cluster queue until Thursday."
                data-testid=${`paper-weekly-update-box-${props.paperId}`}
                ?disabled=${props.busy}
                .value=${own?.body ?? ""}
                @change=${(event: Event) => {
                  const value = (event.target as HTMLTextAreaElement).value.trim();
                  if (value && value !== own?.body) {
                    props.onSave?.(value);
                  }
                }}
              ></textarea>
              <span class="weekly-updates__hint">
                ${own
                  ? "Saved. Edit the box and click outside it to update this week's entry."
                  : "Two lines is plenty. It saves when you click outside the box."}
                This is what your coauthors read on Monday, and what stops the Sunday reminder
                asking you for it.
              </span>
            </label>
          `
        : nothing}
      ${groups.length === 0
        ? html`<p class="weekly-updates__empty">
            No updates logged yet${props.onSave ? " — yours would be the first" : ""}.
          </p>`
        : html`
            <ol class="weekly-updates__log">
              ${groups.map(
                ([week, entries]) => html`
                  <li class="weekly-updates__week-group">
                    <span class="weekly-updates__week-label"
                      >${adminBotFormatWeek(week)}${week === thisWeek ? " · this week" : ""}</span
                    >
                    <ul class="weekly-updates__entries">
                      ${entries.map(
                        (entry) => html`
                          <li
                            class="weekly-updates__entry"
                            data-testid=${`paper-weekly-update-${props.paperId}-${entry.member_id}-${entry.week_start}`}
                          >
                            <span class="weekly-updates__author"
                              >${nameFor(props, entry.member_id)}</span
                            >
                            <span class="weekly-updates__body">${entry.body}</span>
                          </li>
                        `,
                      )}
                    </ul>
                  </li>
                `,
              )}
            </ol>
          `}
    </details>
  `;
}
