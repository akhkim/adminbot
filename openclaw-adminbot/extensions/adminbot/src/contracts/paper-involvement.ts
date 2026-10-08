// Which papers are "yours": the one rule the Dashboard, My Work, the Profile and the notification
// bell filter the lab's papers by, and the one `GET /papers?scope=mine` answers with, so the page
// that reads only its viewer's papers shows exactly the rows it used to pick out of the full list.
import { isSamePerson } from "./person-names.js";

export type PaperInvolvementFields = {
  submitted_by_member_id?: string;
  first_author_member_id?: string;
  mentor_member_id?: string;
  author_links?: ReadonlyArray<{ member_id?: string }>;
  authors?: readonly string[];
};

export function paperInvolvesMember(
  paper: PaperInvolvementFields,
  memberId: string | null | undefined,
  memberName: string | null | undefined,
): boolean {
  const name = memberName ?? "";
  return Boolean(
    (memberId && paper.submitted_by_member_id === memberId) ||
    (memberId && paper.first_author_member_id === memberId) ||
    (memberId && paper.mentor_member_id === memberId) ||
    (memberId && (paper.author_links ?? []).some((link) => link.member_id === memberId)) ||
    // Author entries carry marks that are about authorship, not identity -- "Joeun Yook*" for
    // equal contribution, "Yook, Joeun" from a BibTeX paste, an accent the roster spells
    // differently -- so names compare as people, not strings.
    (name.length > 0 && (paper.authors ?? []).some((author) => isSamePerson(author, name))),
  );
}
