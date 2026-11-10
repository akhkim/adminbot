# My Desk search and row actions evidence

Captured 2026-11-10 from the Vite dev server (`ui/`, this branch) by calling the real
`renderProfessorView` with the app's real CSS. The props were synthetic. The callbacks were stubbed
in the page: Submitted and Undo changed the status in memory, and the paper buttons removed the row.
This is a component preview with a mocked backend. No service, member session, network write or
message was involved.

Synthetic data:

- Five rec-letter requests: Jane Doe (two), Mei Chen, Omar Reyes and Ada Lim. Ada's is already
  completed.
  - Omar's deadline is the year-less "Nov 5".
  - Jane's second request is the year-less "Dec 15".
- Three PI-review papers: a plain arXiv release, a NeurIPS camera-ready proofread, and a feedback
  request.

Desktop is in dark mode at 800 px wide. Mobile is 390×844 and has no horizontal page overflow.

- `desktop-overview.jpg`: both searches are empty.
  - The completed letter for Ada is gone.
  - Omar's "Nov 5" is read as 2026-11-05 and marked overdue with "(year assumed)". The year is not
    pushed out to 2027.
  - Each letter has a Submitted button.
  - The arXiv row has Approve publication and the feedback row has Feedback done. The camera-ready
    row only opens the paper.
- `desktop-letter-search.jpg`: typing "jane" shows only Jane's two open requests, with a count.
  - "Dec 15" resolves to 2026-12-15 (year assumed).
- `desktop-letter-submitted-undo.jpg`: after Submitted is clicked on Jane's first request, it moves
  to the collapsed "Submitted from this page" list, which has an Undo button.
- `desktop-paper-search.jpg`: "neurips" matches the camera-ready paper by its venue.
- `mobile-letters.jpg`: the letter queue on a phone. The date wraps under the name and school.

Not verified here:

- The live round trip to `PUT /logistics/requests/:id/status` and the paper-slot save. Both are
  covered by the controller and HTTP suites.
- The access split between an admin session and a member session in a real browser.
