# Design system v6: response to the v5 review

The input is `reviews/system-v5/review.md` (reject: B1, B2, M1 to M7, m1 to m15, 32 mutants of which 30
survived), the v4 review for history, the owner's direction, and, from the coordinator, the flow screens'
v5 revision (`flows/REVISION.md`, "v5": the overflow on screens 12 and 7, B1 on screen 5, the gaps G17 to
G27 and G11). Status: **not reviewed.** It needs an independent review under `project/review.md`.

v5 was rejected for problems that came back in new forms after v4's fixes. So for each finding this
response names the root cause, the change, and the automated check that would have caught it and now
guards it, and shows that check failing on v5 first. "Before" is v5 exactly as reviewed: a copy of
`design-system/` taken at the start of this session, before any edit (byte-identical `src/components.css`,
md5 `a17b9866…`), built by its own tools. Nothing outside `design-system/` was edited; `flows/`,
`reviews/system-v4/`, `reviews/system-v5/` and `app/` were not touched. Nothing was published.

## Blockers

### B1. Colour slots: a filtered-out series returned grey; a query edited and back greyed everything

**Root cause.** Not one clause but the shape of the rules: v5 assigned colours over what was *drawn*
(the chart filtered first, then called `assignSeries`), so a filtered-out series looked absent and its
slot could be handed to anything new; and an absent series' slot was given away *and its owner recorded
as Other*, so it could never come back. Rules 4 and 5 described two different algorithms, and the code
followed one of them.

**Change.** One algorithm, written once (Chart README, "Series colour", rules 2 to 7; the code comment in
`assignSeries` is the same text):

- A series is *there* when it is in the result **or when the view's own filter hides it** (a filter in
  the chart, or a label matcher a dashboard filter adds to the query): a filter hides a series, it does
  not remove it, so its slot stays held. Assignment runs over the result, before the filter.
- Each result: continuing series keep their colour; returning series keep the colour they had (Other if
  they were in Other; their slot if no series holds it now, the most recent holder winning a tie); new
  series, and returning ones whose slot another series holds, take by rank the lowest free slot, else the
  reserved slot whose holder has been away longest, else Other.
- The note about Other is counted over what the legend lists, with a sentence for "nothing coloured"
  ("No series is coloured: the 8 coloured are filtered out" / "are not in this result").
- "Colour the eight largest" restarts the map from what is drawn.

One decision with real alternatives sits inside this: whether a grey series still on screen may be
promoted when a slot frees up. It may not (survivors are never repainted), so a narrowing query edit can
leave only Other on screen; the note says why and offers "Colour the eight largest". The alternative
(promote) breaks the round trip: the promoted series would hold the slot when its owner returns.

**Guard.** `tools/test/chart-rules.test.mjs`, run by `npm test`, on the reference chart's own functions
(the one source of `dist/viz-chart.js`), without a page:

| Test | v5 (failing first, run on the v5 copy) | v6 |
|---|---|---|
| Image 01: filter out the three largest, a larger pod arrives, clear | **fails**: `checkout-api-…3742c` came back in slot 0 (Other), had 1 | passes: 3742c back in slot 1; the new pod in Other; note "1 in Other is now larger than a coloured series" |
| Image 02: query edited to search's pods and back | **fails**: `…b2d84` slot 0, had 4 (all 36 in Other) | passes: all eight back; note "8 coloured by size when first seen; 28 in Other" |
| Flow screen 5: one series, then 36 pods, then back (coordinator) | **fails**: cart came back grey | passes: cart back in slot 1 |
| A filter in the query (server side) with pods arriving meanwhile | **fails** | passes |
| 400 random sequences of 30 steps (arrive, leave, values move, filter in the chart, filter in the query, clear, edit and back, open Other, pick members, Colour the eight largest), checking P1 to P6 after every step | **fails** (P2 on the 1st sequence) | passes |

The properties checked after every step: P1 a series in two consecutive results keeps its colour; P2 a
filter cleared or a query edited back returns every series in its own colour; P3 a returning series
takes the colour it had, and a new one goes to Other only when all eight slots are held, never grey while
a smaller placed series is coloured; P4 "highest" is the highest of every drawn series, Other's members
included; P5 the text form's threshold lines, Other line and note are computed over every drawn series;
P6 the note's counts are the legend's and "larger than a coloured series" needs one. The property test
found one ambiguity while I wrote the code: a series that had been in Other came back *coloured* after a
query round trip (it took a slot reserved for a departed series). The rule now says a returning series
keeps the colour it had.

**Teeth.** Chart mutants C1 to C9 in the corpus, each caught by this test: v5's order (filter before
assignment), a returning Other member taking a slot, a returning series never getting its slot back, new
series never taking a reserved slot, "highest" over coloured lines only, the threshold over coloured
lines only, the note counted over the result, a lost minus sign, an axis pinned at zero.

**Images.** `compare/v6-b1-filter-new-pod-clear-*` and `compare/v6-b1-query-edit-and-back-*`: the
reviewer's two sequences played on the Chart preview, v5 on the left (3742c grey in Other; one grey band),
v6 on the right.

### B2. The Table patterns scrolled sideways at 400 px and 200% zoom

**Root cause.** Two pattern-level gaps, not one line. (1) A scrolling or clipping box that is not a
containing block lets anything absolutely placed inside it escape: `.vz-table-wrap` scrolled but was
not positioned, so the visually hidden "Actions" head widened the page. (2) The fold pattern had no
rule for content wider than a kept column (a status could not wrap; a phrase could be wider than
`keep`), no place for the row's actions (`width: 0`), and nothing said a folding table must not scroll.

**Change.**

- `.vz-table-wrap { position: relative }`: what is placed inside is clipped by its scroll.
- In both fold forms: a kept column is `keep` wide but never narrower than its longest unbreakable phrase
  (`min-width: min-content`); a state in it wraps between words, its mark centred on the first line
  (`.vz-status` aligns its mark to the first line everywhere, so this is the same picture for one line);
  `td.vz-row-actions` ends the key's line in every row (order 1, its own width), so "Actions…" is always
  on screen with its hit area inside the row (also flows G20, G26); no gutter after a right-aligned
  column once folded (flows G21).
- The narrow and wide fold forms are one pattern: every folding rule now has its `data-fold="wide"`
  twin, including Waterfall's and Log's, which had none.
- The rule: **a folding table never scrolls sideways**; one whose columns do not fit 640 px is
  `data-fold="wide"` (Table README; the dialog composition's list, Log and Waterfall now are).

**Guard.**

- `tools/audit.mjs` (new): every preview as a page, `dist/reference.html`, the fixture, the compositions
  and the flow screens, at 320, 400, 560, 640, 800, 1024, 1280 and 1500 px fine, 320, 400 and 768 px
  coarse, and 200% zoom of 1280, 1440 and 1500 px windows. It fails on a page that scrolls sideways
  (naming what sticks out), anything absolutely placed inside a clipping box whose containing block is
  outside it, a head or cell outside its table, a folding table that scrolls, a word cut by a clipping
  edge or out of view (outside strips that scroll on purpose and text cut on purpose with an ellipsis),
  and text below micro. Run on v5 first (quick set: 320 and 400 coarse, 720 at 200%, 1500): **126
  findings**, among them every image of B2: the Table preview 249 / 169 px wider than the window at 320 /
  400 (image 03), `dist/reference.html` 177 px at 400, the dialog composition 38 px at 200% (image 05)
  with the `vz-sr` head named as escaping, "budget" of "Burning budget" and "Actions…" cut at 400 coarse
  (image 04), plus what the review did not list: the Monitors fold table in the Table preview and the
  reference scrolling 7 to 11 px at 320 ("Threshold", "10 min" cut), the secret composition's keys table
  scrolling 102 px at 320 with "Never, created just now" cut, Log and Waterfall folding tables scrolling
  6 to 47 px at 200% zoom and at 1500 (m15), and the Cover preview 640 px wider (m13).
- `check.mjs` structure: the wrap is positioned; the kept column's status wraps and has its minimum
  width; the actions cell has its place; the fold forms are twins (mutants V1, V2, V3, V4, V15).
- Corpus A1 to A3: the audit itself catches the escaping head, the cut state and the cut "Actions…" when
  each fix is removed.

<!-- AUDIT-RESULT -->

<!-- SECTIONS -->
