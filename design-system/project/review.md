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
| Tokens | Does `check.mjs` pass on the changed code: no literal colours, lengths, durations, opacity, angles, percentages or weights, and every breakpoint a token? | blocker |
| Colour | Is colour confined to action buttons, status marks and chart series? At most one blue button? | blocker |
| Contrast | Do all pairings in the images meet the floors, in each theme, including every series on every surface it or its swatch rests on (ground, raised, sunken, hover, rule)? | blocker |
| Type | Only the defined styles? Numbers in `mono`, right-aligned? No capitals, no tracking? | major |
| Hierarchy | In a greyscale copy of the image, does the eye reach the author's three things in their order? | major |
| States | Are loading, empty, error, partial, hover, focus, pressed, busy and disabled designed and imaged? | blocker if focus or error is missing, else major |
| Keyboard | Can the change be operated without a pointer, in reading order, with a visible ring throughout? | blocker |
| Screen reader | Do controls have names and roles, and do live regions announce only real changes (not every pointer move)? | blocker |
| Speed | Are the budgets met at both layouts (`speed.json`, desktop; `speed-phone.json`, 400 px with a coarse pointer), with before and after numbers measured in the same session, the load average and core count recorded beside them, typing measured key by key in the real editor, and the 36- and 200-series cases measured? A timing from a run whose load exceeded the cores is not judged either way; the author measures again. Any waiting state on a local change? | blocker |
| Feedback | Is every indicator meaningful, accurate (measured, never faked, age stated) and useful? | blocker if inaccurate, else major |
| Stale data | While a new request waits, or after it was cancelled or failed, does every label on the old data (title, unit, legend, range, age, accessible name, text form) still describe the data drawn, with "Showing the previous query" in the head? | blocker |
| Consistency | Across the screens of a flow and within one screen, does each event have one time and each figure one value, and do figures shown together agree with each other and with the chart? | blocker if a person would act on the wrong one, else major |
| Agent content | Is everything an agent wrote marked where it is read (provenance line or "Agent:", the left rule, "Not verified" until a person confirms), with its evidence query? Does any agent text appear as a status word, figure or title unmarked? | blocker |
| Touch | With a coarse pointer, does every control have a 44px hit area with no overlap, and work without hover? A link inside a sentence is text and is exempt; the main path of a flow is never one (if it is, that is this row's failure). | blocker |
| Touch parity | Can a finger do everything a pointer and a keyboard can: no modifier keys, no drag-only or hover-only action, zoom in and out by button, a readout that does not cover what it reports? | blocker for a missing action, else major |
| Narrow and zoom | At 400px, and at 200% zoom, does it reflow with no sideways page scroll, no text below `micro`, no columns a list exists for behind a sideways scroll, and layout shift under 0.05 when the page loads scrolled to a region? | blocker |
| Reduced motion | With reduced motion requested, is every transition gone and nothing lost? | major |
| Text form | Does the digest carry the same information as the visual form? | major |
| Charts | Does the value axis start where it says, is the step and aggregate stated, does the time axis end at the range's end, are thresholds and intervals labelled in words, do direct labels sit on their own lines (or are absent)? Can every drawn series be told from every other without hue: by the lightness step and the dash of slots 5 to 8, and, for a single line, by direct label, emphasis from the legend or the readout's name? | major |
| Many series | With 36 and with 200 series: is everything past eight one "Other" entry (one band, one legend row), do survivors keep their colour or their place in Other when a filter changes and when it is cleared, were the coloured series the largest when they were first seen, and whenever a series in Other is larger than a coloured one, does the legend note say so? Do legend names show the distinguishing labels first, and does the readout's "highest" include the members of Other? | blocker if a colour or a label names the wrong series (a readout naming a smaller series as highest, a filtered-out series returning grey), else major. Budgets are judged under Speed |
| Words | Minor: a button that is not a verb. Major: a number without a unit, or a result that hides that it is partial. | minor to major |
| Detail | Baselines, alignment, truncation, spacing symmetry | minor |
| System | Does it use only existing components and tokens, or list each new one with its reason? Does any preview or screen need an inline style or its own margins? | major |

## After review

Blockers and majors are fixed and the images regenerated. Minors may be fixed or recorded as follow-ups. If the change needed a new token or component, this system is updated in the same pull request.
