# Design re-review, round 4: dashboards and monitors

Reviewed 2026-11-28, about 16:30 to 17:45 UTC, by an independent reviewer: an agent session that
did not write the app, the design system or any of the PR files, and was not given the author's
reasoning. Findings were formed from the rubric, the running view and my own images; the author's
dispositions (`app/README.md`, "The third design review: dashboards and monitors";
`reviews/app-dashboards/PR.md` and `reviews/app-monitors/PR.md`, "Third design review") were read
only after the findings below were written (section "The author's claims against what I found").

- **What was reviewed.** `app/` at commit `3bed27a`, in a frozen worktree in my scratch area,
  built there (`npm run build`), served by `vite preview` over the development mock, and over a
  second mock started with keys for each scope case (`--require-token`, `--readless-token`,
  `--dashboards-token`, `--monitors-token`, `--oncall-token`). The release switch that hides the
  two views from the navigation is not on this commit; that is not a finding.
- **Scope.** Part 2 (dashboards, `/dashboards`, `/dashboards?id=…`) and part 3 (monitors,
  `/monitors`, `/monitors?id=…`, acknowledge, silence with its 60 s undo) of
  `rereview.md`: the state of D-B1, D-B2, D-M1, D-M2, d1 to d9, M-B1, M-M1, M-M2, o1 to o8, and
  anything new. Explore, Help, Settings and the palette are not in scope.
- **Ground truth.** `project/review.md` (rubric), `project/README.md` (rules, "Words",
  "Responsiveness and feedback"), `project/method.md`, `tokens.json`,
  `project/components/Chart/README.md` ("The algorithm", "Off screen"),
  `project/components/Menu/README.md`; AGENTS.md "Design changes"; the session rule (SR) of
  `reviews/chart-speed/third-review.md` §4.
- **How.** Playwright (`chromium.launch()`, headless shell), one browser job at a time under the
  shared machine lock, Cloudflare credentials removed, no Cloudflare call. 1500 px fine pointer and
  400 px touch emulation (coarse pointer), both themes; 200% zoom as 750 CSS px at device scale 2;
  reduced motion; keyboard only (Tab through every stop, rings read as computed). Hit areas at
  400 px coarse were read by asking the page which element owns each point round a control's centre
  with the control scrolled to the middle of the window, on every visible control of six pages
  (no full-page screenshot, see the tool note at the end). No reload was read under `hasTouch`.
- Images I cite are mine, under `rereview-r4-images/`, unless an author's file is named.

## Verdicts

| Part | Verdict | Why, in one line |
|---|---|---|
| Dashboards | **SEE BELOW** | |
| Monitors | **SEE BELOW** | |

(filled in after the second timing session)
