# 13 — Dashboard and control density

Date: 2026-11-28. Author role: product design for data-dense tools (observability, trading, analytics).
The question, from the owner: *investigate improving the density of dashboards and controls while
remaining intuitive.* This file is the background; the measurements, prototypes, evaluation and
recommendation are in `design-system/proposals/density/README.md`.

**Tags.** **[V]** verified from the page linked, fetched on 2026-11-28. **[S]** secondary: a
summary, a search result or another author's account of the primary source, not read in full.
**[T]** training knowledge: a lead, not a fact. Measurements of viz itself are not here; they are
in the proposal and are "measured here".

**What could not be reached.** m3.material.io and m2.material.io pages render no text to a fetcher
(both returned only a title); the Material figures below come from the Material Components for
the web density package README instead. developer.apple.com's HIG page rendered no text. The
Bloomberg article "How Bloomberg Terminal UX designers conceal complexity" returned 403; only its
search summary was read. The Medium article "Using Material Density on the Web" returned 403. The
Honeycomb boards page returned 404. Microsoft's spacing page redirected to a general layout page
without the compact-sizing figures.

---

## 1. How dense, well-regarded tools do it

### Grafana

- **Panel menu on hover.** "To access the panel editor, hover the cursor over the top-right corner
  of any panel", then click the panel menu icon that appears; the menu holds View, Edit, Inspect
  and Remove. Panel shortcuts (`e` edit, `v` full screen, `p l` toggle legend) act on "a panel
  with the mouse" hovering over it. [V] ([panel overview](https://grafana.com/docs/grafana/latest/panels-visualizations/panel-overview/),
  [use dashboards](https://grafana.com/docs/grafana/latest/dashboards/use-dashboards/))
  So Grafana's densest chrome depends on hover; on touch and from the keyboard the menu and the
  shortcuts are harder to find. That is exactly what this system forbids ("Nothing depends on
  hover").
- **Panel header.** Title, description and links are optional parts of the header; "Hide panel
  time range" removes the panel's own time range from it. [V] (panel overview) The description
  shows as an "i" with a hover tooltip. [T]
- **Time range as one control.** The time picker is one control: relative ranges from a list,
  absolute From/To, zoom out (also `t-`), copy and paste a range (`t c`, `t v`). [V] (use dashboards)
  Shift back and forward arrows beside it. [T]
- **Legend.** Mode is List or Table; placement Bottom or Right; values (last, min, max…) can be
  added; the legend can be switched off. [V] ([configure legend](https://grafana.com/docs/grafana/latest/panels-visualizations/configure-legend/))
  The default for a time series is a list at the bottom. [T]
- **Rows** group panels and collapse; `d e` expands all rows. [V] (use dashboards) A collapsed row
  does not query its panels until opened. [T]
- **Kiosk mode** hides the main menu and the dashboard's top bar; Esc leaves it. [V] (use dashboards)

### Datadog

- **High-density mode** shows group widgets side by side "for increased widget density"; it turns
  on by default on large screens for dashboards built from groups, and is toggled from an icon at
  the top right. [S] (search summary of [configure](https://docs.datadoghq.com/dashboards/configure/)
  and the [2021 dashboards post](https://www.datadoghq.com/blog/datadog-dashboards/)) It is the
  closest analogue to "use the twelve columns at 1440": density from layout, not from smaller type.
- One global time frame selector for the dashboard and template variables as a row of dropdowns
  above it. [T]

### Kibana

- Panel titles can be hidden per panel and for the whole dashboard; panel borders can be turned
  off; the panel menu (a vertical-dots icon) holds Settings, Maximize, Duplicate and so on;
  collapsed sections do not load their panels. [V] ([arrange panels](https://www.elastic.co/docs/explore-analyze/dashboards/arrange-panels))

### Honeycomb, New Relic, Linear, Notion

- Honeycomb boards list queries with small previews; New Relic dashboards put a "…" menu in each
  widget's header and a single time picker at the top. [T] Neither page could be checked here.
- Linear and Notion are the reference for "quiet chrome": commands live in a command palette and
  in per-item menus, nearly nothing is visible until it is needed, and the keyboard is the fast
  path. [T] Their users are in the tool all day; an on-call reader opening a dashboard at night is
  not, which matters for discoverability (section 4).

### Bloomberg Terminal

- The Terminal's designers describe its "tight, information-dense screen" as what makes the
  hierarchy hard to clarify, and change it in small steps because even a moved button disrupts
  experts. [S] (search summary of the [Bloomberg article](https://www.bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity/))
- Matt Strom's essay on UI density uses it as the main example and defines density as "the value
  a user gets from the interface divided by the time and space the interface occupies"; its
  strength is near-instant loading between many views, i.e. density in time as much as in space.
  [V] ([UI density](https://mattstromawn.com/writing/ui-density/)) This matches this system's speed
  budgets: a denser page that is slower to paint is not denser by that definition.

## 2. Design-system density guidance

- **Material (components for the web).** A density scale from 0 (default) to negative numbers;
  "The density interval is set to 4px"; a 36 px button at scale −3 is 24 px. And: "Touch targets
  are automatically disabled when density mixins are applied", because dense components are
  opt-in and do not carry the default accessibility requirements. [V] ([@material/density README](https://cdn.jsdelivr.net/npm/@material/density@14.0.0/README.md))
  The Material guidance recommends density for lists, tables and long forms, and not for
  components that need focus or are used by touch. [S] (search summary; the M2 "Applying density"
  page did not render)
- **Carbon.** Data table rows at 24, 32, 40, 48 and 64 px (xs to xl); the head matches the rows;
  xs and sm pair with the 32 px toolbar; xl only for two lines in a row. [V] ([data table style](https://carbondesignsystem.com/components/data-table/style/))
  viz's `row` (32 px) is Carbon's "sm".
- **Fluent / WinUI.** Standard and compact sizing; compact reduces control heights (32 to 24 epx is
  the usual figure) and is meant for information-dense pages with a mouse. [T] (the page fetched did
  not have the figures) Spacing: 8 epx between buttons, 12 between a control and its label or
  between content areas, 16 to the surface edge. [V] ([content layout and spacing](https://learn.microsoft.com/en-us/windows/apps/design/basics/content-basics))
- **Apple HIG.** 44 × 44 pt minimum on iOS and iPadOS; macOS uses smaller standard controls
  because its input is a pointer. [T] (page did not render)
- **What they agree on** [S, from the above]: density is a property of the input as much as of the
  content. Every system that offers a compact scale either drops its touch targets with it
  (Material) or reserves compact for pointer-driven, information-dense screens (Fluent, macOS).
  None of them makes a phone denser by shrinking its targets.

## 3. Target size: WCAG 2.2 and this system's 44 px rule

- **2.5.8 Target Size (Minimum), level AA:** "The size of the target for pointer inputs is at
  least 24 by 24 CSS pixels", except where undersized targets are spaced so that a 24 px circle on
  each does not intersect another target, where the target is in a sentence or "otherwise
  constrained by the line-height of non-target text", and a few other cases. [V] ([Understanding 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html))
- **2.5.5 Target Size (Enhanced), level AAA,** uses 44 × 44 CSS px; the 2.5.8 page advises aiming
  for it for important controls. [V] (same page)
- **How this interacts with the system.** viz already sits between the two: with a fine pointer
  every hit target is at least 24 px (2.5.8) and primary controls 32 px; with a coarse pointer
  every control has a 44 px hit area (2.5.5) (`project/method.md`, "Details that are checked").
  A fine-pointer compact scale can therefore go down to 24 px targets and still meet AA; it may
  not take anything under 24, and it must not reach the coarse layout. The system's coarse rules
  are written as `@media (pointer: coarse)`, so a compact scale written as `@media (pointer: fine)`
  cannot reach them.
- **2.4.11 Focus Not Obscured (Minimum), level AA:** a focused component must not be "entirely
  hidden due to author-created content"; sticky headers are the named risk (failure F110) and CSS
  `scroll-padding` is a sufficient technique (C43). [V] ([Understanding 2.4.11](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html))
  Any sticky dashboard bar needs `scroll-padding-top` at least its height.

## 4. Progressive disclosure and discoverability

- **Progressive disclosure** "defers advanced or rarely used features to a secondary screen"; it
  works only if the split between primary and secondary is right and "it must be obvious how users
  progress from the primary to the secondary disclosure levels", with a label that sets clear
  expectations. [V] ([NN/g, progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/))
- **Hidden navigation costs discoverability.** NN/g's 179-participant study: on desktop, hidden
  navigation was used in 27% of cases against 48% (visible) and 50% (combo); people were at least
  39% slower when it was hidden; on mobile 57% against 86% and 15% slower; overall "a more than
  20% drop in discoverability". [V] ([NN/g, hamburger menus](https://www.nngroup.com/articles/hamburger-menus/))
  The study is about site navigation, not a panel's commands; the direction (hidden is found less,
  and the cost is larger on desktop) is the lead for this question, not the size.
- **Hover-only affordances** are invisible to touch, and keyboard users reach them only if they are
  also focusable; this system already requires anything revealed on hover to be reachable by focus
  and tap (`project/README.md`, "Every form factor"). [V, the system's own rule]
- **Implication for viz.** A per-panel "Actions…" menu is acceptable only if the button is always
  visible, labelled with words, and the commands an on-call reader needs on the first visit
  (open the query in Explore, read the panel as text) are not only in it. Grafana's hover-revealed
  panel menu is the pattern not to copy.

## 5. Data-ink, small multiples and reading many small charts

- **Data-ink** (Tufte, *The Visual Display of Quantitative Information*, 1983): maximise the share
  of ink that shows data; erase non-data ink and redundant data ink, within reason. [T] Strom's
  essay restates it as "Every bit of ink on a graphic requires reason" and argues that whitespace
  and grouping can carry meaning, so the ratio is only part of density. [V] (UI density)
- **Small multiples** (Tufte, *Envisioning Information*, 1990): the same chart repeated over a
  variable, read by comparison. [T]
- **Chart height.** Heer, Kong and Agrawala (CHI 2009) measured value-difference estimates on line
  charts 500 px wide at heights from 48 px down to 2 px: error stayed stable at the larger sizes and
  rose as charts shrank; for line charts "a chart height of 24 pixels … to be optimal" in the
  speed–accuracy trade-off; below 24 px, mirrored two-band horizon charts were more accurate.
  [V] ([paper](https://hci.stanford.edu/courses/cs448b/w09/Heer-Horizon.pdf), section "Optimal chart sizing")
  The task was reading one value difference, not finding which of eight lines rose; it says a
  dashboard's 200 px plot is far above the point where accuracy falls, and that shrinking it by
  a quarter costs little for value reading. It does not say anything about labels, legends or
  crossing lines.
- **Shared versus split space.** Javed, McDonnel and Elmqvist (InfoVis 2010) compared simple line
  graphs, braided graphs, small multiples and horizon graphs: shared-space charts were faster for
  local comparisons (a local maximum), split-space charts (small multiples, horizon graphs) for
  comparisons across a large visual span, and split-space techniques appeared to scale better with
  more series (an informal follow-up). [V] ([paper](https://cs.au.dk/~elm/pdf/multilinevis.pdf),
  findings list) For viz: "which service has the most errors" over a 3 h window is a dispersed
  comparison; a row of four stats or a table answers it better than four lines in one chart.

## 6. Design implications for viz

1. Density should come from **structure** (fewer lines of chrome per panel, one row of controls,
   legends that fit the number of series) before it comes from **scale** (smaller rows and gaps).
   The proposal measures this on the 12-panel dashboard at 1440: a one-step-smaller spacing scale
   alone shortens the page by 3%; restructuring the chrome with every command still visible, by
   18%; putting the commands and descriptions behind menus, by 24% (`proposals/density/`).
2. **Pointer-adaptive** scale, never a smaller touch layout: a fine pointer may go to 24 px
   targets and one step down the spacing scale; a coarse pointer keeps 44 px (WCAG 2.5.8 and 2.5.5;
   Material disables touch targets when dense).
3. **No hover-only chrome.** Commands move into a visible, worded control on the panel's own head
   line, or into one labelled menu; never revealed by hover (NN/g; the system's own rule).
4. **The range is one control whose label is the range as read**, as Grafana's picker is, with
   Show earlier and Show later beside it on a wide screen.
5. **Legend by number of series:** a list for a few series, the table for many (Grafana offers
   both; the system has only the table).
6. **A sticky bar needs scroll padding** (WCAG 2.4.11).
7. **One density for everyone, adapted by pointer**, rather than a Comfortable/Compact setting:
   every vendor that offers a setting doubles the states a design must be reviewed in; viz's
   review process (both themes, both pointers, every state) would double with it. [the author's
   judgement, argued in the proposal]

## Open questions

- Whether on-call readers find a panel's "Actions…" menu on a first visit: the proposal's
  evaluation is by task walk-through and an independent design judgement, not a usability test.
- Whether a lower plot (for example 168 px instead of 200 px at 1440) loses anything; Heer et al.
  suggest not for value reading; crossing lines and direct labels were not studied. The proposal
  did not prototype a lower plot: the chrome around the plot was the larger cost.

## Sources

- W3C, Understanding SC 2.5.8 Target Size (Minimum): https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- W3C, Understanding SC 2.4.11 Focus Not Obscured (Minimum): https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html
- Grafana, Panel overview: https://grafana.com/docs/grafana/latest/panels-visualizations/panel-overview/
- Grafana, Use dashboards: https://grafana.com/docs/grafana/latest/dashboards/use-dashboards/
- Grafana, Configure a legend: https://grafana.com/docs/grafana/latest/panels-visualizations/configure-legend/
- Elastic, Arrange panels: https://www.elastic.co/docs/explore-analyze/dashboards/arrange-panels
- Datadog, Configure dashboards: https://docs.datadoghq.com/dashboards/configure/ (search summary)
- Datadog blog, the new dashboards experience: https://www.datadoghq.com/blog/datadog-dashboards/ (search summary)
- Material Components for the web, density README: https://cdn.jsdelivr.net/npm/@material/density@14.0.0/README.md
- Carbon, Data table style: https://carbondesignsystem.com/components/data-table/style/
- Microsoft, Content layout and spacing: https://learn.microsoft.com/en-us/windows/apps/design/basics/content-basics
- NN/g, Progressive disclosure: https://www.nngroup.com/articles/progressive-disclosure/
- NN/g, Hamburger menus and hidden navigation hurt UX metrics: https://www.nngroup.com/articles/hamburger-menus/
- M. Strom, UI density: https://mattstromawn.com/writing/ui-density/
- Bloomberg, How Bloomberg Terminal UX designers conceal complexity (not reachable; search summary): https://www.bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity/
- J. Heer, N. Kong, M. Agrawala, Sizing the Horizon, CHI 2009: https://hci.stanford.edu/courses/cs448b/w09/Heer-Horizon.pdf
- W. Javed, B. McDonnel, N. Elmqvist, Graphical Perception of Multiple Time Series, InfoVis 2010: https://cs.au.dk/~elm/pdf/multilinevis.pdf
