# Working-groups slide sync

Everything in this folder is synthetic. It was produced without calling the Google API, without
reading the real deck, and with a made-up roster and `example.com` photos.

## The synthetic slide

The slide is modelled on "Scaling to 50-100 Technical Members" and was built in memory:

- six rounded boxes;
- round faces 0.55 in across, 0.1 in apart, six to a row, with a thin white ring;
- every face placed by hand, as on the live slide.

The same measure → plan → request code the service uses was run over it.

## Files

- **`before-after.svg`** is what the preview route `GET /slides/working-groups/preview?format=svg`
  draws. Every face is a circle with initials, never a photo:
  - grey means already there;
  - `?` means a hand-placed image tied to nobody;
  - green means added;
  - orange means would be removed, but removals are off.

  A full box gets a red dashed outline and a `+N` badge, where N is the number of people who
  belong but did not fit.
- **`example-plan.json`** has:
  - for each box: `added`, `no_room`, `would_remove` and `skipped_no_photo`;
  - the request counts and a sample request pair;
  - a check that every existing image is unchanged after the requests are applied;
  - the rerun result;
  - the same plan with `ADMINBOT_SLIDES_ALLOW_REMOVALS=1`.
- **`round-face-sample.png`** is a synthetic gradient run through the production circle mask and
  ring (`connectors/slides-face-image.ts`). The corners are transparent and the ring is white, as
  on the slide.

## Scenario

| Box                 | On the slide                                        | Roster says                                                         | Plan                                                                    |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Interpretability    | 22 faces, 3 of people the rule does not select      | 19 of them plus 3 joiners                                           | **full**: only 2 slots left, so nobody is added; `no_room` lists all 3 |
| Power Concentration | 12 faces with no alt text                           | 2 members with "AI governance"; 1 with "ML powered causality"       | 2 added after the 12th face; the third goes to Causality, not here      |
| Adversarial Defense | 5 faces                                             | 1 shown member became alumni; 1 joiner                              | 1 added; the alumna's hand-placed face stays                            |
| Multi-Agent         | 12 faces                                            | 10 of them plus 1 joiner                                            | 1 added, wrapping onto a new row                                        |
| Loss of Control     | 5 faces                                             | the same 5                                                          | unchanged                                                               |
| Causality           | 11 hand-placed faces, 1 AdminBot face for a leaver, 1 stray face off the slide's right edge | the 11, the stray's person, 2 joiners, 1 joiner with no photo | 2 added; the stray's person is not added again; the leaver is under `would_remove`; the photo-less joiner is under `skipped_no_photo` |

## Results

- **Requests.** The plan sends 6 `createImage` and 6 `updatePageElementAltText` requests, and no
  `deleteObject` or transform requests.
- **Existing images.** After the requests are applied, every existing image has the same position
  and size as before.
- **Rerun.** Planning again gives 0 requests. Interpretability is still reported as `full`.
- **With removals on.** `ADMINBOT_SLIDES_ALLOW_REMOVALS=1` adds a single `deleteObject`, for the
  leaver's AdminBot-tagged face. Hand-placed faces are never candidates for removal.
