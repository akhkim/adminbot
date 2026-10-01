# Feedback follow-ups evidence

Actual Lit components and production styles, disconnected synthetic component fixture; all save/send callbacks are no-ops. No production records or invitations. Baseline is main 98195f9145b78697a071b571bc760a1cb0b797c3; after is b2783c2311d92196de8a166bbb08ddaf1306c8f9. Same missing-artifact input, dark theme and desktop viewport for matched comparisons.

- paper-before/after.jpg: native-resolution crops from browser full-page captures, preserving paper heading, timeline and field availability summary. Controls were already editable in main; this change removes misleading waiting/locked presentation and dependency wording.
- member-before/after.jpg: native-resolution crops of actual Add member modal. The checked contact default applies only to new records. Visible example text is existing product placeholder text, not saved member data.
- paper-mobile.jpg: native-resolution crop of responsive light fixture at verified iPhone14 CSS390x844, no horizontal document overflow.
- member-mobile.jpg: native-resolution crop of light Add member modal at the same phone viewport, contact checkbox and help visible.

Interaction verification: actual Add member popover opened/closed; checked default and user opt-out verified; all paper timeline lanes remain visible with missing artifacts; presentation deck moves from slides to poster without requiring PDF; venue decision remains derived/waiting. Fields use no-op saves, so this is UI evidence, not backend persistence or delivered-mail proof. Existing tests cover saved opt-outs, calendar deduplication and denied sheet writes. Native images inspected; rendered PR pass is pending until publication.
