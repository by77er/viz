# Design system v7: response to the v6 review

The input is `reviews/system-v6/review.md` (reject: B1, B2, M1, minors m1 to m6, the flow screens' notes, 20 new mutants of
which 17 survived), its eleven images, `reviews/system-v6/response.md` for what v6 did, and the coordinator's direction, which carries
the project lead's decision on B2 ("what a person sees wins"). Status: **not reviewed.** It needs an independent review under
`project/review.md`.

"Before" is v6 exactly as it was on disk at the start of this session: a copy of `design-system/` (md5 of `src/components.css`
`f9594320…`) taken before any edit and built by its own tools, in the session's scratch area. Every failing-first run below was run
against that copy. Nothing outside `design-system/` was edited; `flows/`, `reviews/system-v4/`, `reviews/system-v5/`,
`reviews/system-v6/` and `app/` were not touched. Nothing was published. No git command was run.

## How it was checked

All on this machine: 4 cores shared with other sessions, 16 GB. The 1-minute load average was 5.9 to 11 through the session (each
run below gives its own). One browser at a time, at most one test worker, every server stopped.

- **Failing first, on v6.** The new chart tests, the page audit's new checks and the reviewer's mutants were each run against the
  v6 copy before any v7 result was taken.
- **`npm test`**: `chart-rules.test.mjs` (17 tests) and `check.test.mjs` (the corpus without its browser mutants).
- **`tools/mutants.mjs`**: the whole corpus, 130 mutants, browser mutants included, each on a copy in the scratch area (one base
  directory, each copy deleted after its run; the runner refuses a directory inside the tree).
- **`tools/check.mjs`** on the component CSS (with the rendered contrast and reservation audit), the previews, the compositions
  and the fixtures.
- **`tools/audit.mjs`**: every page (31 previews, the reference, the fixture, the 11 compositions, and the 12 flow screens reported
  apart) at 14 configurations, with the new overlap and key-width checks at every one, the guards, the token trace and a
  reduced-motion pass.
- **Images**: `tools/shots.mjs` before (the v6 copy) and after, same markup and state, composed side by side in `compare/`;
  compositions at 1500 px and 400 px with a coarse pointer, both themes, 320 px, 200% zoom, hit areas and greyscale, in `images/`.
- **Speed**: `tools/speed.mjs --compare`, both shipped scenarios, v6's fixture and v7's alternating run by run, and a Chromium
  trace of the theme change.

RESULTS
