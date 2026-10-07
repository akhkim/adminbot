// The author list, as people rather than as a comma-separated string.
//
// It used to be one text box, and the string in it had to be matched back to the roster every time
// anybody asked whose paper this was. That match is guesswork -- "Joeun Yook*", "Yook, Joeun", an
// accent the roster spells differently -- and every miss hid a paper from a coauthor on their own
// work. So the question is asked once, here, at the moment somebody adds the author: which of
// these people is it?
//
// Three kinds of row, and the difference is the whole design:
//   - a lab member, picked from the roster. The paper appears on their My Projects page.
//   - an external, added by email. They appear in this list and nowhere else in AdminBot: no
//     roster row, no account, no nudges. The address is recorded so the lab knows who they are.
//   - an unlinked name, from a paper written before this existed. Shown with a prompt to resolve
//     it, never silently guessed at.
//
// Order is the print order and is load-bearing (the venue-stage nudges walk it to find the first
// lab member), so rows move with explicit buttons rather than drag-and-drop, which is unusable on
// touch and invisible to a keyboard.
import { html, nothing } from "lit";
import { adminBotNormalizeXHandle } from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { icons } from "../../icons.ts";
import { renderMemberSelect, type MemberOption } from "./member-select.ts";

export type PaperAuthorLink = {
  name: string;
  member_id?: string;
  email?: string;
  /**
   * The X handle to tag this author by, stored bare. Externals only: a lab member's handle is on
   * their profile, and asking for it twice is asking for two answers that can disagree.
   */
  twitter?: string;
};

export type PaperCoauthorsProps = {
  paperId: string;
  links: PaperAuthorLink[];
  /** The roster to search. Empty renders the picker disabled rather than hiding it. */
  members: MemberOption[];
  /** Absent for a reader who may not edit this paper. */
  onChange?: (links: PaperAuthorLink[]) => void;
  /** Draft state for the add controls, held by the caller so a re-render does not clear it. */
  draftEmail: string;
  draftName: string;
  draftTwitter: string;
  onDraftChange: (draft: { email?: string; name?: string; twitter?: string }) => void;
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function isEmailLike(value: string): boolean {
  return EMAIL_SHAPE.test(value.trim());
}

function nameForMember(members: MemberOption[], memberId: string): string {
  return members.find((member) => member.id === memberId)?.name ?? memberId;
}

function move(links: PaperAuthorLink[], index: number, delta: number): PaperAuthorLink[] {
  const next = [...links];
  const target = index + delta;
  if (target < 0 || target >= next.length) {
    return links;
  }
  const [row] = next.splice(index, 1);
  if (row) {
    next.splice(target, 0, row);
  }
  return next;
}

function renderRow(props: PaperCoauthorsProps, link: PaperAuthorLink, index: number) {
  const commit = (links: PaperAuthorLink[]) => props.onChange?.(links);
  const kind = link.member_id ? "member" : link.email ? "external" : "unlinked";
  const label =
    kind === "member"
      ? nameForMember(props.members, link.member_id as string)
      : link.name || link.email || "";
  return html`
    <li
      class=${`coauthor coauthor--${kind}`}
      data-testid=${`paper-coauthor-${props.paperId}-${index}`}
    >
      <span class="coauthor__order ab-num">${index + 1}</span>
      <span class="coauthor__identity">
        <span class="coauthor__name">${label}</span>
        ${kind === "member"
          ? html`<span class="coauthor__badge coauthor__badge--member">lab member</span>`
          : kind === "external"
            ? html`<span class="coauthor__badge">${link.email}</span>`
            : html`<span class="coauthor__badge coauthor__badge--unlinked"
                >not linked — this paper will not show on their page</span
              >`}
        <!-- Shown for whoever has one, which in practice is the externals: a member's handle is
             read off their profile and never stored here, so an absent badge on a member row is
             not a gap in the paper's record. -->
        ${link.twitter
          ? html`<span
              class="coauthor__badge coauthor__badge--x"
              data-testid=${`paper-coauthor-x-${props.paperId}-${index}`}
              >@${link.twitter}</span
            >`
          : nothing}
      </span>
      ${props.onChange
        ? html`
            <span class="coauthor__actions">
              <button
                type="button"
                class="btn btn--sm"
                title="Move earlier"
                ?disabled=${index === 0}
                data-testid=${`paper-coauthor-up-${props.paperId}-${index}`}
                @click=${() => commit(move(props.links, index, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                class="btn btn--sm"
                title="Move later"
                ?disabled=${index === props.links.length - 1}
                data-testid=${`paper-coauthor-down-${props.paperId}-${index}`}
                @click=${() => commit(move(props.links, index, 1))}
              >
                ↓
              </button>
              <button
                type="button"
                class="btn btn--sm"
                title="Remove from the author list"
                data-testid=${`paper-coauthor-remove-${props.paperId}-${index}`}
                @click=${() => commit(props.links.filter((_, at) => at !== index))}
              >
                ${icons.x}
              </button>
            </span>
          `
        : nothing}
    </li>
  `;
}

export function renderPaperCoauthors(props: PaperCoauthorsProps) {
  const commit = (links: PaperAuthorLink[]) => props.onChange?.(links);
  const alreadyOn = new Set(props.links.map((link) => link.member_id).filter(Boolean));
  // Somebody already on the paper is not offered again: adding them twice is never what was meant,
  // and the service would collapse the duplicate anyway.
  const options = props.members.filter((member) => !alreadyOn.has(member.id));
  const draftEmail = props.draftEmail.trim();
  // Null for blank and for anything X would not accept, which are different things to the reader
  // and the same thing to the record: only a handle that can actually be @-ed is worth storing.
  const draftTwitter = adminBotNormalizeXHandle(props.draftTwitter);
  const twitterRejected = props.draftTwitter.trim().length > 0 && !draftTwitter;
  const canAddExternal = isEmailLike(draftEmail) && !twitterRejected;

  return html`
    <section class="coauthors" data-testid=${`paper-coauthors-${props.paperId}`}>
      <span class="paper-detail__label">Authors</span>
      ${props.links.length === 0
        ? html`<p class="coauthors__empty">Nobody on this paper yet.</p>`
        : html`<ol class="coauthors__list">
            ${props.links.map((link, index) => renderRow(props, link, index))}
          </ol>`}
      <span class="paper-detail__hint">
        In the order the paper prints them. The first lab member on this list gets the venue-stage
        emails, and everyone marked as a lab member sees this paper on their own page.
      </span>
      ${props.onChange
        ? html`
            <div class="coauthors__add">
              <div class="coauthors__add-member">
                ${renderMemberSelect({
                  options,
                  value: "",
                  placeholder: "Search the lab roster…",
                  label: "Add a lab member as an author",
                  disabled: options.length === 0,
                  onPick: (memberId: string) =>
                    commit([
                      ...props.links,
                      { name: nameForMember(props.members, memberId), member_id: memberId },
                    ]),
                })}
              </div>
              <!-- The external half. An address, not a roster row: this person goes on the paper
                   and gets nothing else -- no account, no nudges, nothing addressed to them. -->
              <div class="coauthors__add-external">
                <input
                  class="input"
                  type="text"
                  placeholder="Name (optional)"
                  .value=${props.draftName}
                  data-testid=${`paper-coauthor-external-name-${props.paperId}`}
                  @input=${(event: Event) =>
                    props.onDraftChange({ name: (event.target as HTMLInputElement).value })}
                />
                <input
                  class="input"
                  type="email"
                  placeholder="external.coauthor@university.edu"
                  .value=${props.draftEmail}
                  data-testid=${`paper-coauthor-external-email-${props.paperId}`}
                  @input=${(event: Event) =>
                    props.onDraftChange({ email: (event.target as HTMLInputElement).value })}
                />
                <!-- The handle the announcement will tag them by. Optional: a coauthor who is
                     not on X still belongs on the paper, and the post names them in plain text
                     instead. -->
                <input
                  class="input"
                  type="text"
                  placeholder="@handle on X (optional)"
                  .value=${props.draftTwitter}
                  data-testid=${`paper-coauthor-external-twitter-${props.paperId}`}
                  @input=${(event: Event) =>
                    props.onDraftChange({ twitter: (event.target as HTMLInputElement).value })}
                />
                ${twitterRejected
                  ? html`<p
                      class="coauthors__error"
                      role="alert"
                      data-testid=${`paper-coauthor-external-twitter-error-${props.paperId}`}
                    >
                      That is not an X handle. Up to 15 letters, digits or underscores — or paste
                      their profile link.
                    </p>`
                  : nothing}
                <button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${!canAddExternal}
                  data-testid=${`paper-coauthor-add-external-${props.paperId}`}
                  @click=${() => {
                    commit([
                      ...props.links,
                      {
                        name: props.draftName.trim() || draftEmail,
                        email: draftEmail.toLowerCase(),
                        ...(draftTwitter ? { twitter: draftTwitter } : {}),
                      },
                    ]);
                    props.onDraftChange({ email: "", name: "", twitter: "" });
                  }}
                >
                  Add external author
                </button>
              </div>
            </div>
          `
        : nothing}
    </section>
  `;
}
