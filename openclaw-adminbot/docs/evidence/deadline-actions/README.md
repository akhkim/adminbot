# Deadline actions evidence

Actual Lit deadline component with production styles, two synthetic venue names/locations, synthetic signed-in member and in-memory stores. No live API writes, timeline changes, or messages. Baseline component/styles from a5f737e3; after from this PR.

Before/after mobile use the same 390 × 844 viewport, dark theme and input. Browser screenshot encoding is JPEG (device-scaled pixels). Desktop after is 1280 × 900. Countdown seconds naturally differ. No image manipulation.

Verified Cards, Groups and Table actions; recommendation opens its draft dialog without sending; details retain Seattle location. Table retains its existing horizontal-scroll layout. Timeline save uses a no-op callback, so these images do not prove server persistence. Existing focused tests cover successful/failed timeline saves and recommendation behavior.

Dark and light mobile files and desktop context checked visually. PR rendering is checked after publication.
