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

A reviewer who did not write the change and has not seen the author's reasoning. The reviewer works from the images, the running view and this system, and returns a verdict of **approve**, **approve with changes** or **reject**, with findings tied to a rule here. The verdict is recorded on the pull request. A change may merge automatically once the verdict is approve and the checks pass.

## Rubric

A finding at **blocker** level prevents approval.

| Area | Question | Level if failed |
|---|---|---|
| Purpose | Does each element pass the presence test? | blocker for whole regions, major for single elements |
| Tokens | Are all colours, sizes, radii and durations tokens? | blocker |
| Colour | Is colour confined to actions, status marks and chart series? At most one blue button? | blocker |
| Contrast | Do text and meaningful marks meet their floors in both themes? | blocker |
| Type | Only the defined styles? Numbers in `mono`, tabular, right-aligned? No capitals? | major |
| Speed | Are the budgets in "Responsiveness and feedback" met, with measurements attached? Any loading state on a local view change? | blocker |
| Feedback | Is every indicator meaningful (a change the person caused or needs), accurate (measured, never faked, age stated) and useful (says what is happening and what to do)? | blocker if inaccurate, else major |
| Touch | With a coarse pointer, does every control have a 44px hit area and work without hover? | blocker |
| Hierarchy | In greyscale, is the reading order the intended one? | major |
| States | Are loading, empty, error, partial, hover, focus, pressed and disabled designed? | blocker if focus or error is missing, else major |
| Keyboard | Can the change be operated without a pointer, in reading order? | blocker |
| Text form | Does the digest carry the same information? | major |
| Words | Verbs on buttons, units on numbers, sentence case, completeness stated? | minor to major |
| Narrow | At 400px, does it reflow without horizontal page scroll? | blocker |
| Detail | Baselines, alignment, truncation, spacing symmetry | minor |
| Sameness | Does it look like the rest of the product, or like a template? | major |

## After review

Blockers and majors are fixed and the images regenerated. Minors may be fixed or recorded as follow-ups. If the change needed a new token or component, this system is updated in the same pull request.
