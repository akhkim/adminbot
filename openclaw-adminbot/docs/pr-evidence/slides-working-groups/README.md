# Working-groups slide sync

This evidence is entirely synthetic. It was produced without calling the Google API and without
touching the real deck. A 10 × 5.625 in slide modelled on "Scaling to 50-100 Technical Members"
(six rounded boxes, round faces of 0.55 in) was built in memory. It was run through the same
measure → plan → request code the service uses, with a made-up roster. The rerun was done on the
result of applying the requests to that in-memory slide.

- **`before-after.svg`** draws the slide before and after the plan. Circles with initials stand in
  for photos: grey is unchanged, blue has moved or been resized, green is new, and red has been
  removed. The live route `GET /slides/working-groups/preview?format=svg` produces the
  same drawing.
- **`example-plan.json`** contains, for each group, the status, who was added and removed, how
  many faces moved, and the resulting face size. It also has the request counts, a sample of each
  request type, and the rerun result.

| Box                 | Before                       | Roster change                        | Result                                   |
| ------------------- | ---------------------------- | ------------------------------------ | ---------------------------------------- |
| Interpretability    | 9 faces                      | 3 joiners                            | Overflows, so all faces shrink to 0.491 in, centred |
| Power Concentration | 6 faces                      | (no theme)                           | Untouched                                |
| Adversarial Defense | 7 faces                      | 1 member became alumni               | 1 face deleted, the rest close the gap at 0.55 in |
| Multi-Agent         | 14 faces, already spilling   | 8 joiners                            | Spilled faces pulled back, all shrink to 0.363 in |
| Loss of Control     | 5 faces                      | none                                 | Unchanged                                |
| Causality           | 3 faces                      | 1 joiner, 1 joiner with no photo     | 1 face added at 0.55 in; the other is listed in `skipped_no_photo` |

The plan sends 1 `deleteObject`, 27 `updatePageElementTransform` and 12 `createImage` requests.
Re-planning after they are applied gives 0 requests, with every box `unchanged` or `untouched`.
