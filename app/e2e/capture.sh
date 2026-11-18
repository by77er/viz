#!/bin/sh
# Design-review screenshots through design-system/tools/shots.mjs.
#   e2e/capture.sh <before|after> [app-url]
# ONLY=<name> captures one view. TABLE_VIEW=chart is for the app before the restyle, where the
# table sat under the chart instead of being a form of its own.
# Needs the mock on 8841 and `vite --config e2e/vite.shots.config.ts --port 8840` running.
set -e
OUT=$(cd "$(dirname "$0")/../.." && pwd)/design-system/reviews/app-restyle/$1
APP=${2:-http://127.0.0.1:8840}
SHOTS=$(cd "$(dirname "$0")/../.." && pwd)/design-system/tools/shots.mjs
W="from=1794994200000&to=1795005000000"
Q_RATE="sum%20by%20(service)%20(rate(http_requests_total%5B5m%5D))"
Q_MANY="sum%20by%20(service%2C%20route%2C%20status)%20(rate(http_requests_total%5B5m%5D))"
Q_BAD="sum%20by%20(service)%20(rate(http_requests_total%5B5m%5D)"
shot() { if [ -z "$ONLY" ] || [ "$ONLY" = "$2" ]; then echo "== $2"; node "$SHOTS" capture "$1" "$OUT" "$2"; fi; }
shot "$APP/explore?q=$Q_RATE&$W" explore
shot "$APP/explore?q=$Q_MANY&$W" many-series
shot "$APP/explore?q=$Q_RATE&$W&view=${TABLE_VIEW:-table}" table
shot "$APP/explore?q=$Q_RATE&$W&view=text" text
shot "$APP/explore?q=no_such_metric_total&$W" empty
shot "$APP/explore?q=$Q_BAD&$W" error
shot "$APP/explore" start
shot "$APP/explore?q=pod_cpu_usage_cores%7Bservice%3D%22checkout%22%7D&$W&step=1s" rollup-and-gap
shot "$APP/explore?q=$Q_RATE&$W#shot=timepicker" time-picker
shot "$APP/explore?q=$Q_RATE&$W#shot=palette" command-palette
shot "$APP/explore?q=$Q_RATE&$W#shot=settings" settings
