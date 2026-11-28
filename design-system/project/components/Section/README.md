How a page is divided below its head, and how prose sits in it. Three classes, so no page or preview writes its own margins.

- **`vz-section`**: a `vz-section-title` (`h2`, `heading`) and its content, `space-3` apart. A heading is always closer to its own content than to what is above it.
- **`vz-sections`**: a column of sections, `space-8` apart. Each column of a `vz-split` already is one. Panels in a dashboard are `space-6` apart (Panel); sections of a page are `space-8`.
- **`vz-text`**: a paragraph of prose in a page, a section or a column: margin 0, `measure` wide, in `ink`. **`vz-secondary`** is the same in `ink-secondary`, for the sentence beside an action ("Creates revision 15. You can restore revision 14.") or under a title; `data-size="sm"` sets it in `small`. Inside a dialog the consequence sentence is `vz-dialog-text`.

Presence test: a section exists when its heading names a question the page answers ("Most likely", "Checked and ruled out", "Could not check"); a heading over a single element that already has a title (a panel) is removed.
