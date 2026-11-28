#!/bin/bash
# legend-writes.test.cjs on the change, then on six mutants of it (copies of dist/ in the scratch area; the tree is never touched)
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
S=/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/b1c5
cd $S/tools
echo "[lw] the change: $(date -u +%T)"
VIZ_BEFORE=$S/final/design-system VIZ_AFTER=$S/new/design-system node --test legend-writes.test.cjs 2>&1 | grep -E "^# (pass|fail)|steps compared|not ok" | head -5
i=0
while IFS='|' read -r name from to; do
  i=$((i+1)); M=$S/mut/m$i/design-system; rm -rf "${M:?}"; mkdir -p $M/dist; cp -r $S/new/design-system/dist/. $M/dist/
  python3 -I -c "import sys; p=sys.argv[1]; s=open(p).read(); a,b=sys.argv[2],sys.argv[3]; assert s.count(a)==1,(a,s.count(a)); open(p,'w').write(s.replace(a,b))" $M/dist/viz-chart.js "$from" "$to" || { echo "mutant $i not applied"; continue; }
  r=$(VIZ_SEEDS=12 VIZ_BEFORE=$S/final/design-system VIZ_AFTER=$M node --test legend-writes.test.cjs 2>&1)
  echo "[lw] mutant $i ($name): $(echo "$r" | grep -E '^# fail' ) $(echo "$r" | grep -oE "width [0-9]+, seed [0-9]+, step [0-9]+ \([^)]*\): [a-z]+ differs" | head -1)"
done <<'M'
a changed figure is not written|if (c !== p[1][j]) tbody.rows[i].cells[j + 1].outerHTML = c|if (false) tbody.rows[i].cells[j + 1].outerHTML = c
focus in the legend is not looked at|legendWrap.contains(document.activeElement)|false
the note is not written again|noteHtml !== written.note|false
a row whose first cell changed is not written|else if (html(p) !== html(r)) tbody.rows[i].outerHTML = html(r)|else if (false) tbody.rows[i].outerHTML = html(r)
the head is not written again|headHtml !== written.head|false
the column widths are not written again|colsHtml !== written.cols|false
a sort or Show more keeps what is written|const afresh = !reuse || |const afresh = 
M
echo "[lw] done $(date -u +%T)"
