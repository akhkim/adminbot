# Paper feedback queue

Synthetic actual-component browser evidence; no live records or messages.

The request form offers ARR / Overleaf, arXiv and camera-ready feedback. Each stores a required reason and HTTPS manuscript link, with optional personal feedback-by and official submission cutoff times. Times are stored as UTC and displayed with the reader's time zone. Late requests remain queued with a warning. Removing a request clears its queue entry. Publication approval remains independent.

Screenshots show the initial request form, a confirmed queued request, and the PI's queue, at desktop and iPhone 14 dimensions, with dark and light themes. `desktop-before.png` means the form before submitting the synthetic request, not the previous release. The component harness simulates a successful save; service and route tests independently verify the backend contract and access control. Production persistence and deployment are not claimed.

Pass 1: browser interactions and styled rendering verified. Pass 2: saved screenshots opened and inspected for readable reasons, deadlines, links, controls and mobile layout. Pass 3: rendered PR verification recorded after publication in the checkpoint.

The frontend hides new controls until the connected backend returns feedback slots. Aurora backend installation/start/release remain separately gated; this PR does not authorize them.
