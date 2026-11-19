The product's sections, across the top. `vz-nav`: the name, then links; the current one has `aria-current="page"` and is `ink` in `ui-strong`. The group at the right (the tenant, Settings) starts with a link carrying `vz-nav-end`, which pushes it to the right edge; no spacer element.

It scrolls sideways on narrow screens instead of collapsing into a menu, so every section stays one tap away. Below 640px its gutter and gap are `space-4`, like the page's. The first focusable element of a page is a skip link (`a.vz-button.vz-skip`, "Skip to content"): it takes no space until it is focused, then it appears over the top left of the nav.

In running text, links are `vz-link`: `ink` with an underline that thickens on hover. Links are never blue.
