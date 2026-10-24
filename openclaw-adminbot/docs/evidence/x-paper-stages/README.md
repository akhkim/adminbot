# Paper X thread evidence

Synthetic data rendered by the actual `renderPaperCycle` component with production styles. No model calls, live backend changes or social posts. Before uses main at f5054d9a; after uses this PR. The legacy before component reads `body`; the new component reads structured posts and figures from the same fixture. Dark/light desktop and mobile CSS viewport 390 × 844 were inspected. The browser's existing zoom required a 312 × 675 viewport override to produce that measured CSS viewport; zoom was preserved and the override reset.

Verified interactions: edit → live preview/count → save → render saved text/figure metadata; poster generation callback receives confirmed logistics. API/SQLite/connector behavior is covered separately by mocked/local tests. Both themes and narrow layout were visually inspected. Images are genuine browser JPEGs. `*-detail.jpg` are native-resolution crops of retained context captures, without rescaling. Mobile detail removes blank compositor space; full capture retained.

To repeat: copy `fixture.html` to `ui/.x-thread-preview.html`, write `git show f5054d9a:openclaw-adminbot/ui/src/ui/adminbot/views/paper-cycle.ts` to `ui/src/ui/adminbot/views/.x-thread-before.ts`, start the existing Vite dev server on port 5173, and open `/.x-thread-preview.html` (optional `?before=1` / `?light=1`). Remove the two temporary UI files after checking.

Publishing credentials/scopes, actual model output and live X posting were not exercised. Production verification requires an approved compatible backend release; this PR does not authorize Aurora deployment or PostgreSQL cutover.
