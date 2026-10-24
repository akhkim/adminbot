// Text the topbar search hands to the Lab Members search box when it opens a person or project.
//
// The box is uncontrolled DOM (see filterMemberSpreadsheet in views/admin.ts), so the text waits
// here until the form next renders, is written once, and is cleared so later typing is the
// operator's own. It lives apart from the view because that view is lazy-loaded and the topbar is
// not.
let pending: string | null = null;

export function seedMemberSearch(query: string): void {
  pending = query;
}

export function takeMemberSearchSeed(): string | null {
  const query = pending;
  pending = null;
  return query;
}
