# Design review

Any change to what a person sees or how they operate the interface is a design change. It is reviewed before it merges.

## What the author provides

In the pull request description:

1. The sentence from the method: who is looking and what they are trying to do.
2. **Before and after images** of every changed view, in both themes, at 1440 and 400 pixels wide. Same data, same state, same viewport in each pair.
3. Images of each state the change touches: loading, empty, error, partial, focus.
4. A list of any new tokens or components, each with its reason.
5. The output of the token check.
6. Measurements for the budgets the change touches (input response, typing, view change, first result paint, layout shift), before and after, from `tools/speed.mjs` or a harness that measures the same way, at both layouts: 75th percentile, median and worst run, the many-series cases included, the load average and core count of each run, and whether each was measured on the fixture page or on the application.
7. For a flow of several screens, the review input: the fixture clock and the one set of numbers and times every screen uses, and which text an agent wrote.

## Who reviews

A reviewer who did not write the change and has not seen the author's reasoning. The reviewer works from the images, the running view and this system. Every finding cites an image and a rule.

**Verdicts.**

- **Approve**: no blockers and no majors.
- **Approve with changes**: no blockers; every major has a fix the author has agreed to; no second review is needed.
- **Reject**: any blocker, or three or more majors. The change is re-imaged and reviewed again.

A blocker may be waived only by a second reviewer, who records why. A change may merge automatically once the verdict is approve, or approve with changes and the changes are made, and the checks pass.

## What the author adds for the reviewer

- The **presence-test table**: each element of the changed view and the question it answers.
- The **reading order**: the first three things the eye should reach, in order.
- Dark-theme images are judged on their own, not as a copy of light.

## Rubric

Contrast floors: 4.5:1 for text; 3:1 for marks, series, control borders and the focus ring; disabled controls are exempt. Each failure has one row and one level: where two rows could seem to cover the same failure, the row that names it is the one that applies.

| Area | Question | Level if failed |
|---|---|---|
| Purpose | Does every row of the presence-test table have an answer no other element gives? | blocker for whole regions, major for single elements |
| Tokens | Is every colour, length, duration, opacity, angle, percentage, weight, radius, shadow, easing and breakpoint in the changed code a token (the exceptions are those listed in `tools/lib/lint.mjs`: zero, `1lh`, whole numbers, integer `fr`, geometric 0, 50 and 100%)? `check.mjs` finds them; a literal it misses is still this row's failure, and its pass alone does not answer the question. | blocker |
| Colour | Is colour confined to action buttons, status marks and chart series? At most one blue button? | blocker |
| Contrast | Do all pairings in the images meet the floors, in each theme, including every series on every surface it or its swatch rests on (ground, raised, sunken, hover, rule)? | blocker |
| Type | Only the defined styles? Numbers that are compared or update in place in `mono`, right-aligned in a column of one unit, with the three exceptions the Type rules give and no others: a single large figure (`vz-stat`) in the sans; a column of mixed units left-aligned, each cell with its unit; a quantity in a sentence as `vz-qty`? No capitals, no tracking beyond the type styles' own? | major |
| Hierarchy | In a greyscale copy of the image, does the eye reach the author's three things in their order? | major |
| States | Are loading, empty, error, partial, hover, focus, pressed, busy and disabled designed and imaged? | blocker if focus or error is missing, else major |
| Keyboard | Can the change be operated without a pointer, in reading order, with a visible ring throughout? | blocker |
| Screen reader | Do controls have names and roles, and do live regions announce only real changes (not every pointer move)? | blocker |
| Speed | Are the budgets met at both layouts (`speed.json`, desktop; `speed-phone.json`, 400 px with a coarse pointer and touch: presses and taps by touch events), every budget row measured, with before and after measured in the same session and alternating, the load recorded with every sample, typing measured key by key in the real editor, a press measured by the fill actually painted, and the 36- and 200-series cases measured? A timing row is judged only when most of its samples were taken at a load at or below the core count; above that it is neither passed nor failed, whatever the calibration ratio, and the author measures again. Any waiting state on a local change? | blocker |
| Feedback | Is every indicator meaningful, accurate (measured, never faked, age stated) and useful? | blocker if inaccurate, else major |
| Stale data | While a new request waits, or after it was cancelled or failed, does every label on the old data (title, unit, legend, range, age, accessible name, text form) still describe the data drawn, with "Showing the previous query" in the head? | blocker |
| Consistency | Across the screens of a flow and within one screen, does each event have one time and each figure one value, and do figures shown together agree with each other and with the chart? | blocker if a person would act on the wrong one, else major |
| Agent content | Is everything an agent wrote marked where it is read (provenance line or "Agent:", the left rule, "Not verified" until a person confirms), with its evidence query? Does any agent text appear as a status word, figure or title unmarked? | blocker |
| Touch | With a coarse pointer, does every control have a 44px hit area with no overlap, and work without hover? A link inside a sentence is text and is exempt; the main path of a flow is never one (if it is, that is this row's failure). | blocker |
| Touch parity | Can a finger do everything a pointer and a keyboard can: no modifier keys, no drag-only or hover-only action, zoom in and out by button, a readout that does not cover what it reports? | blocker for a missing action, else major |
| Narrow and zoom | At 400px, and at 200% zoom, does it reflow with no sideways page scroll, no text below `micro`, no columns a list exists for behind a sideways scroll, and layout shift under 0.05 when the page loads scrolled to a region (reloaded scrolled to each chart, as `tools/audit.mjs` does, and landing where it was)? | blocker |
| Reduced motion | With reduced motion requested, is every transition gone and nothing lost? | major |
| Text form | Does the digest carry the same information as the visual form? | major |
| Charts | Does the value axis hold zero and every drawn value, is the step and aggregate stated, does the time axis end at the range's end, are thresholds and intervals labelled in words, do direct labels sit on their own lines (or are absent)? Without hue: do lines in different dash groups (slots 1 to 4 solid, 5 to 8 dashed) differ by dash, and neighbouring slots by the lightness step (1.3:1)? Lines that share both dash and step (1 and 3, 2 and 4, 5 and 7, 6 and 8) are told apart by a direct label, by emphasis from the legend, or by the readout's name; a greyscale image in which two such lines look alike does not fail this row if those three work. | major |
| Many series | With 36 and with 200 series: is everything past eight one "Other" entry (one band, one legend row)? Does the chart follow Chart, "The algorithm" (what a person sees wins: a series that is hidden or not in the result is not on screen): does every series on screen keep its colour while it stays on screen; is the largest series on screen never grey while a slot is open (free, or owned by a series that is hidden or away), whether the screen changed by a query edit, a narrowing, a filter, a round trip or a pod gone; does the same narrowing give the same colours as a query edit and as a dashboard filter; does a series that comes back take its own slot whenever no series on screen holds it; does a query edited to series it does not share and edited back return every series in its own colour; do legend toggles leave every colour as it was? A series that comes back in Other, because a series on screen took its slot while it was away or hidden, follows the rule (the note must then say it is larger than a coloured series). Is "Colour the eight largest" offered exactly when pressing it would change a colour, that is, when one of the eight largest series on screen is not coloured, and never when the eight largest are already coloured (the project lead's decision, v9: "every response meaningful" outranks "offered wherever a series is in Other"; P8 in `tools/test/chart-rules.test.mjs`)? Were the coloured series the largest when they took their colours? Whenever a series in Other is larger than a coloured one, does the legend note say so? Do legend names show the distinguishing labels first, and do the readout's "highest" and the text form include the members of Other? | blocker if a colour or a label names the wrong series (a readout naming a smaller series as highest; a series on screen changing colour while it stays on screen; the largest series on screen grey while a slot is open; a series coming back grey or in another colour while no series on screen holds its slot; a query edited to series it does not share and edited back not returning every colour; each is a test in `tools/test/chart-rules.test.mjs`), else major. Budgets are judged under Speed |
| Words | Minor: a button that is not a verb. Major: a number without a unit, or a result that hides that it is partial. | minor to major |
| Detail | Baselines, alignment, truncation, spacing symmetry | minor |
| System | Does it use only existing components and tokens, or list each new one with its reason? Does any preview or screen need an inline style or its own margins? | major |

## After review

Blockers and majors are fixed and the images regenerated. Minors may be fixed or recorded as follow-ups. If the change needed a new token or component, this system is updated in the same pull request.
