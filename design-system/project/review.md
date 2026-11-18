# Design review

Any change to what a person sees or how they operate the interface is a design change. It is reviewed before it merges.

## What the author provides

In the pull request description:

1. The sentence from the method: who is looking and what they are trying to do.
2. **Before and after images** of every changed view, in both themes, at 1440 and 400 pixels wide. Same data, same state, same viewport in each pair.
3. Images of each state the change touches: loading, empty, error, partial, focus.
4. A list of any new tokens or components, each with its reason.
5. The output of the token check.
6. Measurements for the budgets the change touches (input response, view change, first result paint), before and after, and how they were taken.

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
| Speed | Are the budgets met on the reference setup, with before and after numbers attached? Any waiting state on a local change? | blocker |
| Feedback | Is every indicator meaningful, accurate (measured, never faked, age stated) and useful? | blocker if inaccurate, else major |
| Touch | With a coarse pointer, does every control have a 44px hit area with no overlap, and work without hover? | blocker |
| Narrow and zoom | At 400px, and at 200% zoom, does it reflow with no sideways page scroll and no text below `micro`? | blocker |
| Reduced motion | With reduced motion requested, is every transition gone and nothing lost? | major |
| Text form | Does the digest carry the same information as the visual form? | major |
| Charts | Does the value axis start where it says, is sampling or rollup stated, are up to four series labelled directly? | major |
| Words | Minor: a button that is not a verb. Major: a number without a unit, or a result that hides that it is partial. | minor to major |
| Detail | Baselines, alignment, truncation, spacing symmetry | minor |
| System | Does it use only existing components and tokens, or list each new one with its reason? | major |

## After review

Blockers and majors are fixed and the images regenerated. Minors may be fixed or recorded as follow-ups. If the change needed a new token or component, this system is updated in the same pull request.
