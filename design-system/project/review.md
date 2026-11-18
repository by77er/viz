# Design review

Any change to what a person sees or how they operate the interface is a design change. It is reviewed before it merges.

## What the author provides

In the pull request description:

1. The sentence from the method: who is looking and what they are trying to do.
2. **Before and after images** of every changed view, in both themes, at 1440 and 400 pixels wide. Same data, same state, same viewport in each pair.
3. Images of each state the change touches: loading, empty, error, partial, focus.
4. A list of any new tokens or components, each with its reason.
5. The output of the token check.
6. Measurements for the budgets the change touches (input response, typing, view change, first result paint), before and after, from `tools/speed.mjs` or a harness that measures the same way: 75th percentile and worst run, the many-series cases included, and whether each was measured on the fixture page or on the application.
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

Contrast floors: 4.5:1 for text; 3:1 for marks, control borders and the focus ring; disabled controls are exempt.

| Area | Question | Level if failed |
|---|---|---|
| Purpose | Does every row of the presence-test table have an answer no other element gives? | blocker for whole regions, major for single elements |
| Tokens | Does `check.mjs` pass on the changed code: no literal colours, lengths, durations or opacity? | blocker |
| Colour | Is colour confined to action buttons, status marks and chart series? At most one blue button? | blocker |
| Contrast | Do all pairings in the images meet the floors, in each theme? | blocker |
| Type | Only the defined styles? Numbers in `mono`, right-aligned? No capitals, no tracking? | major |
| Hierarchy | In a greyscale copy of the image, does the eye reach the author's three things in their order? | major |
| States | Are loading, empty, error, partial, hover, focus, pressed, busy and disabled designed and imaged? | blocker if focus or error is missing, else major |
| Keyboard | Can the change be operated without a pointer, in reading order, with a visible ring throughout? | blocker |
| Screen reader | Do controls have names and roles, and do live regions announce only real changes? | blocker |
| Speed | Are the budgets met on the reference setup, with before and after numbers attached? Is typing measured key by key in the real editor, and are the 36- and 200-series cases measured, not only a few series? Any waiting state on a local change? | blocker |
| Feedback | Is every indicator meaningful, accurate (measured, never faked, age stated) and useful? | blocker if inaccurate, else major |
| Stale data | While a new request waits, or after it was cancelled or failed, does every label on the old data (title, unit, legend, range, age, accessible name, text form) still describe the data drawn, with "Showing the previous query" in the head? | blocker |
| Consistency | Across the screens of a flow and within one screen, does each event have one time and each figure one value, and do figures shown together agree with each other and with the chart? | blocker if a person would act on the wrong one, else major |
| Agent content | Is everything an agent wrote marked where it is read (provenance line or "Agent:", the left rule, "Not verified" until a person confirms), with its evidence query? Does any agent text appear as a status word, figure or title unmarked? | blocker |
| Touch | With a coarse pointer, does every control have a 44px hit area with no overlap, and work without hover? | blocker |
| Touch parity | Can a finger do everything a pointer and a keyboard can: no modifier keys, no drag-only or hover-only action, zoom in and out by button, a readout that does not cover what it reports? | blocker for a missing action, else major |
| Narrow and zoom | At 400px, and at 200% zoom, does it reflow with no sideways page scroll and no text below `micro`? | blocker |
| Reduced motion | With reduced motion requested, is every transition gone and nothing lost? | major |
| Text form | Does the digest carry the same information as the visual form? | major |
| Charts | Does the value axis start where it says, is the step and aggregate stated, does the time axis end at the range's end, are thresholds and intervals labelled in words, do direct labels sit on their own lines (or are absent)? | major |
| Many series | With 36 and with 200 series: are the coloured series the largest, is everything else one "Other" entry (one band, one legend row), do survivors keep their colour when a filter changes, do legend names show the distinguishing labels first, and are the budgets still met? | major; blocker if a colour or label names the wrong series |
| Words | Minor: a button that is not a verb. Major: a number without a unit, or a result that hides that it is partial. | minor to major |
| Detail | Baselines, alignment, truncation, spacing symmetry | minor |
| System | Does it use only existing components and tokens, or list each new one with its reason? | major |

## After review

Blockers and majors are fixed and the images regenerated. Minors may be fixed or recorded as follow-ups. If the change needed a new token or component, this system is updated in the same pull request.
