# S14: a preview of the web app, with the mock API

**What it is.** The web app's build (`app/dist/`, the restyle onto design system v9 as it stood in the
working tree on 2026-11-27, not yet design-reviewed) served by one Worker on workers.dev, so the owner can
look at it before the gateway serves the real one (D74). **The data is not viz's**: `/api/*` is answered by
the app's mock (`app/mock/handler.ts`: synthetic series and a subset of PromQL), and the app says so in a
banner. It is not the product and it reads nothing from production.

## What is deployed

- Worker `viz-preview-app` on `https://viz-preview-app.<account-subdomain>.workers.dev`, with the build as
  its static assets (`public/`, a copy of `app/dist/`, git-ignored).
- No binding to any viz Worker, R2 bucket, KV namespace, queue or Durable Object. No route on any zone;
  `vis.bitcru.sh` is not touched. No secret. No timer.
- The Worker answers every path: the four documents and the files by `app/serve.json`'s rules (the same
  content security policy and cache headers the gateway will send), the mock under `/api/`, 404 otherwise,
  `X-Robots-Tag: noindex` on everything.
- **It stops by itself**: after `EXPIRES_AT` (2026-12-04T00:00:00Z, in `wrangler.jsonc`) every request is
  answered 410.

## What it costs

Stated before deploying, modelled at Workers Paid rates: every request invokes the Worker (US$0.30 per
million beyond the plan's included 10 million a month) and a mock query is tens of milliseconds of CPU
(US$0.02 per million CPU-ms beyond the included 30 million). A person looking at it for a week: a few
thousand requests, **US$0.00 beyond the plan**. Worst case, if the address were found and hammered until
the expiry: each million requests about US$0.30 plus up to about US$3 of CPU if all were queries. The URL
is public to anyone who has it; it serves synthetic data only.

## How to use it

Open the address. "Explore" has five example queries on the mock's data. Settings can change the theme.
Do not paste a real API key into its Settings: this preview never needs one, and its API is the mock.

## How it was checked

Measured here, 2026-11-27, `wrangler dev --local` with the Cloudflare credentials removed: the four
documents 200 with the policy and `no-cache`; the assets 200 with their types and `immutable`;
`/index.html`, `/assets/../index.html` and an unknown path 404; a POST to a document 405;
`/api/v1/status/buildinfo` says `"mock": true`; an unknown API path is a JSON 404. A browser opened
`/explore` at 1440 px (light and dark) and 400 px with no console or policy error.

**Deployed 2026-11-27** (version `3c66fe36`), and checked on Cloudflare from outside: the documents 200
with the policy, `/index.html` and an unknown path 404, the asset 200, the mock's buildinfo, a JSON 404 for
an unknown API path; a browser ran the "Request rate by service" example at 1440 px (light and dark) and
400 px with no console or policy error. Created: the Worker `viz-preview-app` and its 8 asset files;
nothing else.

Not checked: nothing beyond the above. The app's own suites are the app builder's to report.

## To update it

```sh
rm -rf public && cp -r ../../app/dist public    # after `npm run build` in app/
npx wrangler deploy
```

## To delete it

```sh
npx wrangler delete --name viz-preview-app
```

Delete it when the gateway serves the app, or when the owner has looked; record that here.
