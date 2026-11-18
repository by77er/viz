# 09 — Frontend architecture, dashboard model, visualization, and agent-first UX

Research date: 2026-11-18. Web access worked (search + fetch). Claims are tagged:

- **[V]** verified against a source fetched or searched in this session (see Sources).
- **[V2]** found only in secondary or third-party sources this session; plausible, not confirmed against a primary source.
- **[T]** training knowledge (cutoff mid-2026), not re-verified this session.
- **[I]** my inference or design judgement.

---

## 0. Executive summary

1. **The industry converged in 2026 on "dashboards are a typed, validated resource that agents patch."** Grafana shipped dynamic dashboards on schema v2 (GA 2026-04-08) and Git Sync (GA 2026-04-20) [V]. SigNoz rebuilt its dashboards on the Perses spec explicitly "for humans and agents" with strict validation and JSON Patch edits (2026-07-29) [V]. Grafana's MCP server exposes patch-style dashboard edits rather than whole-JSON rewrites [V2]. viz should start where they ended up, not where they began.
2. **Spec shape that works for LLMs:** small, declarative, strictly validated, ID-keyed maps instead of positional arrays, layout separated from panel definitions, queries as first-class named objects, a mandatory human/agent-readable `description` per panel, and RFC 6902 JSON Patch with optimistic concurrency as the write path. Every write has a `dry_run` that returns validation errors plus a real-data preview digest.
3. **Agents should read digests, not pixels or raw series.** Datadog's published MCP lessons: CSV/TSV uses roughly half the tokens of JSON for tabular data, YAML about 20% less than JSON for nested data, token-budget pagination beats record-count pagination, specific "did you mean" errors stop retry loops, and fewer flexible tools beat many narrow ones [V]. viz should make a statistical panel digest the default read format, with raw series, tables, and screenshots as opt-in.
4. **MCP is now stateless (spec 2026-07-28) and MCP Apps is an official extension** supported by Claude, ChatGPT, VS Code Copilot, Cursor, Goose and others [V/V2]. This fits Workers exactly: a plain Worker serves `/mcp` with no Durable Object, and a `ui://` resource lets viz render a live interactive panel inside the agent's chat.
5. **Frontend stack:** React 19 SPA on Workers static assets with the Cloudflare Vite plugin, TanStack Router + TanStack Query, shadcn/ui on Base UI, Tailwind v4, CodeMirror 6. TanStack Start reached 1.0 on 2026-10-13 and React Router 8 shipped 2026-06-17; both are officially supported on Workers [V]. I recommend SPA-first with a thin Hono API Worker and treating SSR as optional.
6. **Charts:** uPlot for time series (still the fastest canvas line renderer by a wide margin in the one 2026 benchmark found, but its last release is March 2025 — plan to vendor it) [V2], custom canvas renderers for heatmap, flame graph, and trace waterfall, and Observable Plot (lazy-loaded) for the long tail. WebGPU charting (ChartGPU, created January 2026) is one to watch, not to build on.
7. **One idea that pays twice:** the agent view of a panel (title, description, unit, digest, data table) is also the accessible view for screen readers. Build it once.

---

## 1. Dashboard-as-data models

### 1.1 Grafana

- **Classic dashboard JSON** [T]: one large document; `panels[]` is an array with numeric `id` and inline `gridPos {x,y,w,h}` on a 24-column grid with 30 px row units [V]; `targets[]` per panel; `templating.list[]`; `fieldConfig.defaults/overrides`; `schemaVersion` migrations run in the frontend. Problems for agents: very large (often 50–500 KB), positional arrays, plugin-opaque `options`, UI state mixed with intent, defaults materialized into the JSON, no server-side validation historically.
- **Schema v2 / dynamic dashboards** [V]: GA 2026-04-08. Models dashboard parts as Kubernetes-style kinds. Top-level `elements` is a **map** of `PanelKind` / `LibraryPanelKind`; layout is a separate tree that references elements by key. Four layout kinds: `GridLayout`, `AutoGridLayout` (min column width, row height, max columns), `RowsLayout`, `TabsLayout`; rows and tabs nest up to three levels. Conditional rendering (show/hide by variable value or query result). Section-level variables. v1 dashboards are auto-migrated on load. The Swagger identifier is `dashboard.grafana.app-v2beta1`; the Foundation SDK ships both `dashboardv2` and `dashboardv2beta1` packages, so a stable `v2` API version likely exists [I]. A community thread reports v2 content failing under the v1 `apiVersion` — the envelope version matters [V2].
- **Scenes** [T]: the React object-graph runtime that Grafana's dashboard UI was rebuilt on; v2 schema is essentially the serialization of a scene. Useful as an architecture reference (state objects, behaviours, variable dependency graph), not something to depend on.
- **Foundation SDK** [V/T]: generated typed builders (Go, TypeScript, Python, PHP, Java) for dashboards; the "dashboards as code" path. Builders are good for humans and CI; for agents a JSON Schema plus patch is better than making the model emit and run code.
- **Git Sync** [V]: GA 2026-04-20; bidirectional sync of dashboards with GitHub (GitHub App auth), GitLab, Bitbucket, plain Git [V2]; UI edits become PRs.
- **Agent surface** [V/V2]: July 2026 "AI Week" GA of Assistant Investigations, Workspace, Automations, the Grafana MCP server, the `gcx` CLI, and Agent Observability [V]. `mcp-grafana` has `update_dashboard` accepting full JSON or patch operations, a dashboard summary tool, and JSONPath property extraction; panel-query tools are off by default [V2]. An open issue asked for v2/TabsLayout support in the MCP server, which shows the cost of having two schemas [V].

Lessons: map-keyed elements and a separate layout tree are the right structure. The Kubernetes envelope is verbose (`kind`/`spec` nesting at every level costs tokens). Plugin-defined `vizConfig` blobs remain weakly typed.

### 1.2 Perses (CNCF)

- Still CNCF **Sandbox** (accepted August 2024); no evidence of incubation [V]. Latest release found: v0.54.0 (files dated 2026-07-29), adding Jaeger, GreptimeDB, Splunk, LogExplorer, AlertManager, OpenSearch plugins; it deprecates `@perses-dev/core` in favour of new spec and client packages (data model moving to a `perses/spec` repo) [V2].
- Data model [T, shape confirmed by third-party examples V2]: `kind: Dashboard`, `metadata {name, project}`, `spec { display, duration, variables[], panels{<key>: Panel}, layouts[] }`. Panels are a map; a `Grid` layout's items have `x,y,width,height` and `content: {"$ref": "#/spec/panels/<key>"}`. Everything pluggable is a `{kind, spec}` envelope: `TimeSeriesChart`, `StatChart`, `PrometheusTimeSeriesQuery`, etc. Schemas authored in CUE; Go and CUE SDKs; `percli` for lint/apply/dac build; plugins shipped as module-federated bundles.
- **Adoption signal:** SigNoz (v0.135.0) moved dashboards to a "Perses-compatible schema" with SigNoz-native query/panel plugins, a page → sections → panels → queries → variables hierarchy, strict input validation, JSON-Patch-style `PATCH /api/v2/dashboards/<id>`, and a typed Terraform resource. Their stated lesson: the old free-form JSON was "designed around the UI as its only consumer"; agents had to infer the schema [V]. Dash0 and Chronosphere also use Perses-shaped dashboards [V2]. An OpenSearch Dashboards RFC proposes a Perses compatibility layer [V].
- Caveat: a third-party roadmap note judges the spec "not yet stable enough to build a product on" [V2], and sandbox status implies breaking changes.

### 1.3 Datadog, Honeycomb, Kibana

- **Datadog dashboards** [T]: JSON with `widgets[]` (`definition.type`, `requests[]` with `queries[]` + `formulas[]`), `layout_type: ordered|free`, `template_variables`, and Powerpacks (reusable widget groups). **Notebooks** are ordered cells (markdown + graph) with per-cell time. In 2026 Bits Chat generates whole dashboards, widgets, and notebooks from a prompt; the MCP server's core toolset has `search_datadog_dashboards`, `get_datadog_dashboard`, `create_datadog_notebook` [V]. Notebooks are the natural artifact for an agent investigation; dashboards for standing views.
- **Honeycomb** [V2/T]: Boards are collections of saved queries (plus text/SLO panels); the query spec itself is a tiny JSON (calculations, filters, breakdowns, orders, time range) — the best existing example of an LLM-friendly query object. Hosted MCP exposes board CRUD and `canvas_agent_invoke` / `canvas_agent_poll_response`; Canvas (AI-guided investigation surface) is GA; MCP GA added BubbleUp, heatmaps, histograms [V2].
- **Kibana Lens** [T]: saved objects with by-reference/by-value panels; Lens state is deep and migration-heavy; not a model to copy. ES|QL-driven panels are simpler.

### 1.4 Grammar-of-graphics and BI-as-code (all [T] unless noted)

| System | Model | What to borrow | What to avoid |
|---|---|---|---|
| Vega-Lite | JSON grammar: data, mark, encoding, transform, composition (layer/concat/facet/repeat), params/selections | JSON Schema-first design; LLMs write it well because it is small and heavily represented in training data; `encoding` channel idea for the non-time-series long tail | Full generality is too big a surface for ops panels; Vega runtime is heavy |
| Observable Plot | JS API: marks + scales + transforms | Concise mark model; good SSR to SVG | Code, not data; not patchable |
| Observable Framework | Markdown + JS data loaders, static build | "Page as markdown with embedded charts" maps to an agent-readable report. Status: latest version found 1.13; Observable's 2026 focus is Canvases — treat Framework as low-velocity [V2] | Build-time data |
| Evidence.dev | Markdown + SQL blocks + components | Markdown as the dashboard source: trivially agent-readable and writable | Static-build oriented |
| Malloy / Rill / Lightdash | Semantic layer (measures, dimensions) + dashboards in YAML | **Semantic layer:** named measures with units and descriptions are what agents need to choose queries correctly | BI modelling overhead |
| Streamlit | Imperative Python script | Fast for agents to write | Requires a code sandbox; not declarative, not diffable as data |
| Mosaic/vgplot | Declarative specs + coordinator pushing queries to DuckDB | Cross-filter architecture: clients declare data needs, coordinator batches, caches, pre-aggregates | Tied to SQL/DuckDB |

### 1.5 What makes a spec LLM-friendly

Synthesis [I], supported by the SigNoz, Grafana MCP, Datadog, and json-render evidence above:

1. **Small.** Defaults are implicit and never serialized. A 12-panel dashboard should be under about 3–4 K tokens. Offer an `outline` projection (IDs, titles, kinds, descriptions) under 500 tokens.
2. **Declarative intent, no view state.** No scroll positions, no collapsed flags that are per-user, no pixel sizes other than in an explicit grid layout.
3. **Typed and closed.** Published JSON Schema 2020-12 with `additionalProperties: false`, discriminated unions on `kind`, enums for units. Unknown fields are errors, not silently dropped — silent drop is what makes agents believe an edit worked.
4. **Stable, meaningful IDs; maps not arrays.** `panels: { "p_latency": {...} }` gives stable JSON Pointer paths (`/spec/panels/p_latency/queries/a/expr`). Array indices shift under concurrent edits and make patches unsafe. Agent-chosen slug IDs double as documentation.
5. **Layout separate from content.** Agents mostly should not think about x/y. An `auto` layout (ordered list + min width) is the default; explicit `grid` is opt-in. Both Grafana v2 and Perses separate them.
6. **Patchable.** RFC 6902 JSON Patch (with `test` ops) plus `If-Match` revision. Convergence: SigNoz PATCH, Grafana MCP patch ops, AG-UI `STATE_DELTA`, json-render's JSONL patch stream all use JSON Patch [V/V2].
7. **Composable.** Variables, dashboard-level named queries, fragments (library panels / panel groups with parameters, version-pinned), dashboard links, includes.
8. **Semantic descriptions.** Per dashboard: `intent` (what question it answers, for whom). Per panel: `description` (what it shows, how to read it, what "bad" looks like). Per query: unit and legend. These are cheap for an authoring agent and are the main thing a consuming agent uses.
9. **Validate + dry-run with real data.** Validation layers: schema → references → query parse/type-check → cost/cardinality estimate → execute against real data and return a digest ("query returned 0 series" is the most valuable lint).
10. **Errors written for agents.** Path, expected, got, suggestion.
11. **Provenance and versions built in.** Every revision records author (human or agent, on behalf of whom), tool/session, and a message.

---

## 2. Agent-first and generative UI: state of the art (late 2026)

### 2.1 MCP

- **Spec 2026-07-28** [V]: stateless — no `initialize` handshake, no `Mcp-Session-Id`; each request carries protocol version and client capabilities in `_meta`. Server-initiated requests are replaced by Multi Round-Trip Requests: a tool returns `resultType: "input_required"` and the client retries with the answer (this is how elicitation now works). Required `Mcp-Method`/`Mcp-Name` HTTP headers let WAFs and rate limiters act without parsing bodies. List results carry `ttlMs` and `cacheScope`; tool catalogs are deterministically ordered (prompt-cache friendly). `inputSchema`/`outputSchema` allow full JSON Schema 2020-12; `structuredContent` can be any JSON. Tasks moved to an extension (`io.modelcontextprotocol/tasks`, polled via `tasks/get`). Roots, Sampling, Logging, DCR, and HTTP+SSE are deprecated. Auth: pre-registered clients, then Client ID Metadata Documents, DCR as deprecated fallback; RFC 9207 and RFC 8707 required.
- **On Workers** [V]: `createMcpHandler` (now in the official TS SDK v2, wrapped by the Cloudflare Agents SDK ≥ 0.20) builds a fresh server per request; `McpAgent` (Durable Object per session) is deprecated and feature-frozen. "MCP no longer needs stateful infrastructure." The Workers OAuth Provider implements the new auth requirements.
- **MCP Apps** (SEP-1865, Final; extension `io.modelcontextprotocol/ui`, stable revision 2026-01-26) [V]: tools declare `_meta.ui.resourceUri` pointing at a predeclared `ui://` resource of type `text/html;profile=mcp-app`; `_meta.ui.visibility` can be `["model","app"]` (so some tools are callable only by the UI). The host renders it in a sandboxed iframe and speaks JSON-RPC over postMessage: `ui/initialize`, `ui/notifications/tool-input(-partial)`, `ui/notifications/tool-result`, `ui/message`, `ui/update-model-context`, `ui/open-link`, `ui/request-display-mode` (`inline`, `fullscreen`, `pip`); the view may call `tools/call` and `resources/read`. Resource metadata declares CSP (`connectDomains`, `resourceDomains`, `frameDomains`) and permissions. `HostContext` provides `theme`, CSS variables, locale, time zone, container dimensions. Clients listed as supporting it (October 2026 source): Claude web/desktop, ChatGPT, VS Code Copilot, Microsoft 365 Copilot, Cursor, Goose, Postman, Kiro and others [V2].
- **OpenAI Apps SDK** [V]: ChatGPT added MCP Apps compatibility (February 2026); OpenAI's docs say to use the MCP Apps bridge where an equivalent exists and `window.openai` only for ChatGPT-specific capabilities. One UI bundle can target both.
- **Code Mode** [V2]: Cloudflare's pattern of exposing `search()` + `execute()` (model writes code against a typed API, run in an isolate) cut its own API's tool footprint from about 1.17 M tokens to about 1 K. The gain only materializes for large APIs; for a dozen tools it adds a round trip. Relevant to viz later (bulk dashboard refactors), not for v1.

### 2.2 Generative UI protocols

| Thing | What it is | Status | Relevance to viz |
|---|---|---|---|
| **A2UI** (Google) | Declarative JSON stream describing UI from a client-registered component catalog; framework-agnostic renderers | v0.9, April 2026 [V2]; early | Same philosophy as a dashboard spec: the agent emits data against a catalog, the client renders trusted components |
| **AG-UI** (CopilotKit) | Agent↔frontend event protocol: text, tool calls, `STATE_SNAPSHOT`, `STATE_DELTA` (RFC 6902) | 1.0 reported stable; supported by Bedrock AgentCore (March 2026) and Microsoft Agent Framework [V/V2] | Good fit for the in-app assistant: dashboard draft = shared state, agent streams JSON Patch deltas, UI re-renders live |
| **json-render** (Vercel Labs) | Zod-defined component catalog → generated system prompt and JSON Schema; model streams JSON Patch over JSONL; renders progressively | Launched January 2026, Apache-2.0 [V2] | Closest prior art to "streamed, validated, patch-built dashboard"; the catalog-generates-the-prompt idea is worth copying |
| **Vercel AI SDK generative UI** | Tool calls mapped to React components [T] | Mature | Pattern for the in-app chat: tool result → panel component |
| **Thesys C1** | Hosted API that returns UI instead of text [V2] | Commercial | Not needed: viz's component catalog is the dashboard spec |
| **tldraw computer** | Canvas of LLM-wired components [T] | Experiment | Inspiration for a freeform investigation canvas |

Vendor assistants: **Grafana Assistant** (GA October 2025; Investigations, Automations, Workspace GA July 2026) [V]; **Datadog Bits** (dashboards and notebooks from prompts; MCP server) [V]; **Honeycomb** Query Assistant, Canvas, hosted MCP [V2]; **SigNoz** agent-native dashboards plus a plugin for coding agents (August 2026) [V].

Takeaway [I]: the durable choice is not a generative-UI framework. It is (a) a closed, typed spec that is the component catalog, (b) JSON Patch as the edit stream, (c) MCP + MCP Apps as the distribution channel. Free-form HTML generation by the model is unnecessary and unsafe for a multi-tenant product.

### 2.3 Pages for agents: llms.txt and content negotiation

- Cloudflare **Markdown for Agents** (2026-02-12) [V]: with `Accept: text/markdown`, the edge converts origin HTML to markdown and returns `content-type: text/markdown`, `vary: accept`, and an `x-markdown-tokens` estimate. Only HTML, 2 MB limit. It cannot help a canvas-rendered SPA: there is nothing in the HTML to convert.
- So viz must generate the agent view itself [I]: every dashboard, panel, trace, and explore URL should answer `Accept: text/markdown` (and a `.md` suffix) with a purpose-built markdown document, and `Accept: application/json` with the spec or data. Include a token estimate header and `Vary: Accept`. Publish `/llms.txt` pointing to the API, the MCP endpoint, the schema, and query-language cheat sheets.

### 2.4 How an agent should consume a dashboard

Ordered by token cost [I]; defaults should sit at levels 1–2:

1. **Outline** (~200–500 tokens): title, intent, variables and current values, sections, per panel: id, kind, title, description.
2. **Panel digest** (~100–300 tokens per panel): for each query — series count, unit, time range and step; per series (top-k by a declared ranking, default 5, plus an "other N series" aggregate): `last`, `min`, `max`, `mean`, `p50`, `p95`, percentage change vs previous equal window, trend slope, change points and spikes with timestamps, gaps/staleness, threshold state. Plus a 16–32 bucket quantized sparkline as text when shape matters. Heatmaps: quantiles over time plus mode shifts. Traces: count, error rate, duration quantiles, top slow operations, 3 exemplar trace IDs. Logs: count, rate, top patterns (clustered templates), level breakdown, 3–5 sample lines.
3. **Table** (CSV/TSV, downsampled to N buckets): when the agent needs numbers. TSV about halves tokens vs JSON [V].
4. **Raw series / rows** with token-budget pagination and a cursor [V].
5. **Image** (PNG): only on request. Images cost on the order of 1–2 K tokens each [T], lose exact values, and are needed mainly for shape-heavy views (heatmaps, flame graphs) or for pasting into incident channels. Give vision the data and the picture, never the picture alone.

Every response includes a **deep link** (absolute time range, variables pinned), the **spec revision**, and whether data was truncated or sampled. Annotations (deploys, incidents, agent notes) are returned inline with digests because they are the cheapest causal hints available.

Rendering images on Workers [I]: canvas charts cannot be rendered in a Worker directly. Options: (a) Cloudflare Browser Rendering screenshot of an embed route — highest fidelity, slowest, per-use cost; (b) an isomorphic SVG renderer for simple panel kinds, rasterized with resvg-wasm — fast, cheap, lower fidelity. Start with (a) on demand behind a cache; add (b) for sparklines and alerts.

### 2.5 How an agent should produce a dashboard

Loop [I]: **discover → draft → validate → preview → propose → review → apply → observe.**

- Discover: metric/attribute search with type, unit, label keys, cardinality, and sample values; existing dashboards and fragments to reuse (reuse before create); the spec schema and panel catalog as MCP resources.
- Draft: `create`/`patch` with `dry_run: true` by default in agent contexts.
- Validate: schema, refs, query parse and type check, cost estimate, lint (missing description or unit, more than N series, `rate()` on a gauge, unbounded high-cardinality group-by, duplicate panels, colour-only encoding).
- Preview: execute on real data; return digests and a preview URL (ephemeral draft, TTL). "Returned no data" is surfaced as a warning, not hidden.
- Propose/review: drafts are first-class. A human sees a visual + structural diff (panels added/changed/removed, query diffs) and approves; policy per tenant decides whether agents can apply directly to non-protected dashboards. With MCP elicitation (MRTR) the server can ask the user to confirm an overwrite in the host UI.
- Apply: new immutable revision with provenance; revert is one call. Optional Git export/sync later.
- Observe: usage signals (views, last viewed, panels never scrolled to) fed back so agents can prune.

---

## 3. Charting and rendering at observability scale

### 3.1 Library landscape

| Library | Renderer | Strengths | Weaknesses | Role for viz |
|---|---|---|---|---|
| **uPlot** 1.6.32 | Canvas 2D | Tiny (~50 KB min [T]), fastest line/area time series; one vendor benchmark (ApexCharts, biased) measured 100 K-point line in ~9 ms vs ~1.9 s for ECharts 6.1 on 50 K, and ~2,560 vs ~81 updates/s [V2]; cursor sync built in; used by Grafana's time series panel [T] | Last npm release 2025-03-14 [V2]; single maintainer; imperative API; weak at scatter (6 s for 50 K points in the same test), no heatmap/pie; no built-in a11y | **Primary time-series renderer**, vendored |
| **Apache ECharts 6** | Canvas (SVG optional) | Broad chart set; v6 added new theme, dark mode handling, chord, beeswarm, jitter, reusable custom series [V]; built-in LTTB/min-max sampling and dataZoom [T]; large community | Heavy (hundreds of KB even tree-shaken [T]); slower on dense lines; option object is huge | Alternative "one library for everything" choice |
| **Observable Plot** | SVG | Concise grammar, good defaults, SSR-able | SVG degrades beyond a few thousand marks; not for live high-density series | Long-tail categorical charts; server-side SVG |
| **visx / D3** | SVG/Canvas | Full control | You build everything | D3 scales/shapes/layouts as utilities under custom renderers |
| **Plotly** | SVG + WebGL | Scientific breadth | ~1 MB+ [T], dated interaction model | No |
| **Chart.js / Recharts** | Canvas / SVG | Easy | Recharts SVG collapses at density; neither is ops-grade | No |
| **Lightweight Charts** | Canvas | Excellent financial time axis, small | Finance-oriented; limited multi-series ops features | No |
| **Perspective** (FINOS) | WASM engine + WebGL/Canvas grid | Streaming pivot over Arrow, millions of rows [T] | Heavy WASM, own UI idiom | Possible later "data grid/pivot" explore mode |
| **deck.gl** | WebGL/WebGPU | Geospatial, huge point sets | Overkill outside maps | Only if geo panels are wanted |
| **ChartGPU** | WebGPU | Claims tens of millions of points at 60 fps (self-reported) [V2] | Repo created 2026-01-17; WebGPU needs Chrome/Edge 113+, Safari 18+, Firefox behind/partial [V2] | Watch; revisit in 12 months |

Canvas vs SVG [I]: canvas for anything density-driven (time series, heatmap, flame graph, waterfall, service-map edges); SVG/DOM for anything sparse and text-heavy (stat, bar gauges, legends, tables, axes labels where convenient). WebGL/WebGPU only where canvas 2D measurably fails (dense heatmaps, >100 K-node flame graphs, large scatter).

### 3.2 Downsampling for display

- A chart W pixels wide cannot show more than about W columns. The backend should return at most ~2–4 points per pixel column per series. For PromQL range queries this is just `step = max(scrape_interval, range / width_px)`; the client must send its pixel width (bucketed to limit cache fragmentation) [I].
- For raw-sample or event data [T]: **M4** (first, last, min, max per pixel column; Jugel et al., VLDB 2014) gives a pixel-exact line rasterization and is expressible as a GROUP BY in the query engine; **min-max** keeps the envelope and is what users expect for spikes; **LTTB** keeps visual shape with fewer points but can drop extremes; **MinMaxLTTB** (2023) pre-selects with min-max then LTTB for speed. Recommendation: M4/min-max server-side as the display aggregation; never average spikes away silently — if averaging, also carry min/max and draw a band.
- High-cardinality panels: hard default cap (e.g. 50 series drawn, top-k by a declared stat, rest folded into "other" with a count); beyond that switch representation — quantile bands, heatmap of the distribution, or a table with sparklines. Hover highlights the nearest series by pixel distance with a spatial index; legends are virtualized and sortable by stat.

### 3.3 Specialized views

- **Heatmaps** (native/exponential histograms, latency distributions): canvas `ImageData` or WebGL texture; perceptually uniform sequential palette; log-scale y; click-drag region → "what is different about these requests" (Honeycomb BubbleUp pattern) → exemplar traces.
- **Flame graphs / icicles** (profiles, trace aggregation): canvas with a flattened, pre-sorted node array and binary search hit-testing; text culled by width; diff mode; layout in a worker for big profiles.
- **Trace waterfall**: virtualized rows (TanStack Virtual), canvas minimap, collapse by subtree, critical path highlight, span-link navigation, lazy-load of span attributes; must stay smooth at 10 K–100 K spans — never mount one DOM node per span outside the viewport.
- **Service map**: layout (ELK or d3-force) in a Web Worker; canvas edges, DOM or canvas nodes; RED metrics on nodes/edges; cap node count and offer focus-on-service.
- **Log viewer**: virtual scrolling with variable row height, bidirectional infinite scroll keyed by timestamp+id cursor, a histogram scrubber above, live tail with pause-on-scroll, field sidebar with top values, pattern clustering view.
- **Cross-cutting interactions**: crosshair sync across panels (shared cursor bus, not React state); brush to zoom writes the URL time range; exemplar dots on metric panels link to traces; annotations (deploys, alerts, agent notes) as vertical markers/regions shared by all panels; shift-drag to compare ranges.

### 3.4 Accessibility and colour

- Canvas is opaque to assistive tech. Each panel needs an accessible name, a text summary, and an on-demand data table — the same digest the agent API returns [I].
- Categorical palette: 8–10 hues validated for the common colour-vision deficiencies in both themes, ≥3:1 contrast against the panel background (WCAG non-text contrast) [T]; beyond that, do not add hues — use direct labels, dash patterns, or small multiples. Colour assignment must be **stable per series identity** (hash of the label set, with a per-dashboard override) so `checkout` is the same colour on every panel and after every refresh.
- Reserve red/amber/green for status; do not spend them in the categorical palette. Sequential (single-hue or viridis-like) for heatmaps, diverging for diffs.
- Dark mode is the primary theme for ops tools; design tokens (CSS variables) drive both DOM and canvas renderers. Keyboard: every panel focusable, arrow keys move the cursor, Enter opens the panel menu.

---

## 4. Data transport and client data layer

| Concern | Recommendation | Alternatives / notes |
|---|---|---|
| Prometheus-compatible API | Keep the standard JSON API for ecosystem compatibility (Grafana, promtool) [I] | Too verbose for the viz UI at scale |
| viz UI query API | One `POST /api/query` returning a **frame stream**: columnar frames (time column + value columns + label dictionary). Encode as Arrow IPC stream when large or tabular (logs, spans, raw rows); compact JSON for small results | Protobuf: compact but needs schema tooling and still row-ish; Arrow gives zero-copy typed arrays that feed uPlot directly |
| Arrow decoding | **Flechette** (~14 KB gzip vs ~43 KB for Arrow JS; self-reported 2–7x faster array extraction) [V2]; decode in a Web Worker, transfer typed arrays | apache-arrow JS; note neither source confirmed incremental `ReadableStream` decoding — verify |
| Streaming partial results | HTTP streaming response (`ReadableStream`) with length-prefixed frames or NDJSON; SSE for the assistant/chat stream | WebSocket only where bidirectional or long-lived |
| Progressive refinement | First frame: coarse (cached rollup or sampled, or last cached result re-based), then fine. Mark frames `partial: true` so the chart shows a subtle refining state | Requires engine support for cheap coarse answers (rollups / row-group sampling in Parquet) |
| Live tail | WebSocket to a Durable Object using the hibernation API (per tenant+stream fan-out; idle sockets cost nothing) [T] | SSE via DO is simpler but one-way |
| Client cache | TanStack Query: key = (tenant, query, vars, quantized time range, step); `staleTime` by range recency; dedupe identical queries across panels; cancel on unmount/scroll-away with `AbortSignal` | — |
| Sliding windows | Quantize `now` to the step so repeated refreshes hit the edge cache; fetch only the new tail and splice client-side | — |
| Client-side engine | Do not put DuckDB-WASM on the critical path (multi-MB WASM [T], 4 GB memory ceiling [V]). Lazy-load for an "analyze locally" mode on already-fetched Arrow tables; Arquero for light transforms | Mosaic shows the coordinator pattern (batching, caching, pre-aggregation for cross-filter) — copy the idea server-side |
| URL state | Time range (`from`/`to`, relative or absolute), variables, panel focus, explore query all in typed search params; "copy link" pins absolute times | — |

On Workers specifically [I]: static assets are served without invoking the Worker; `run_worker_first: ["/api/*", "/mcp"]` plus `not_found_handling: "single-page-application"` is the documented pattern [V]. Edge-cache query responses per tenant with short TTLs keyed by the quantized request.

---

## 5. Frontend stack on Cloudflare (November 2026)

### 5.1 Frameworks

| Option | Status on Workers | Fit |
|---|---|---|
| **React 19 SPA + TanStack Router** (Vite + Cloudflare Vite plugin, Hono Worker for API) | Fully supported; plugin runs dev in workerd [V] | **Recommended.** App is auth-gated, long-lived, client-heavy; type-safe search params are ideal for time-range/variable URL state |
| **TanStack Start 1.0** | Stable 2026-10-13, requires Vite 8; official Cloudflare guide [V] | Natural upgrade path from the above (same router) if SSR, server functions, or streaming are wanted. One month past 1.0 — adopt after it settles |
| **React Router 8** (framework mode) | Released 2026-06-17 (ESM-only, middleware default, React 19.2+); ≥8.5 by October; officially supported [V] | Mature alternative with Remix lineage; loaders/actions model; less strict search-param typing |
| **Next.js via OpenNext / vinext** | vinext launched February 2026, reported 1.0 in September 2026, ~94% of Next 16 API [V2] | RSC adds little for a canvas-heavy app; extra moving parts. No |
| **SvelteKit / SolidStart / Qwik** | Supported adapters [T] | Better raw reactivity (Solid especially for high-frequency updates), smaller bundles; weaker ecosystem for the exact pieces needed (grid layout, virtualized tables, shadcn, node-graph, MCP Apps examples) and less LLM codegen fluency |
| **Astro** | Supported [T] | For docs/marketing, not the app |

SSR vs SPA [I]: SSR buys little here — content is per-tenant, behind auth, and the expensive part is queries, not HTML. Costs of SSR: Worker CPU per navigation, hydration complexity around canvas components. Do instead: static shell from the edge (fast TTFB), preload critical chunks, start data fetches before React mounts (router loaders), and serve the machine-readable views (markdown, JSON, OG images, embeds) from plain Worker routes.

### 5.2 Components and tooling

- **Primitives/styling:** shadcn/ui (copy-in components) on **Base UI** (1.0 December 2025; shadcn default for new projects since ~July 2026 [V2]; Radix still supported) + **Tailwind v4** (CSS-variable tokens that canvas renderers can read). Ark UI / React Aria are fine alternatives; React Aria has the strongest a11y story.
- **Tables/virtualization:** TanStack Table + TanStack Virtual. **Command palette:** cmdk.
- **Query editors:** CodeMirror 6 — `@prometheus-io/codemirror-promql` (official Prometheus package: completion, linting, hover) [T], `@grafana/lezer-traceql` (v0.0.25, generated from Tempo's grammar) [V], `@grafana/lezer-logql` [T]. Monaco is several times heavier and awkward to bundle; not worth it for single-line query languages. If viz's dialects diverge, fork the Lezer grammars. The same parsers should run in the Worker for `validate_query`.
- **Grid layout:** `react-grid-layout` v2 (TypeScript rewrite with hooks, pluggable compaction; 2.2.3) [V] for explicit grids in edit mode; plain CSS grid (`auto-fill, minmax()`) for `auto` layouts and all read-only rendering. gridstack is the framework-agnostic alternative (not researched this session).
- **Node graphs:** xyflow (React Flow) for small service maps; custom canvas beyond a few hundred nodes [T].
- **State:** server state in TanStack Query; URL for shareable state; a small store (Zustand or Jotai) for the dashboard edit draft with undo/redo implemented as the same JSON Patch ops the API uses (invert patches for undo); a non-React event bus for cursor sync and streaming appends.

### 5.3 Design references and UX patterns [T/I]

- **Linear:** density, keyboard-first, command palette for everything, optimistic UI, restrained colour.
- **Grafana:** panel/plugin model, explore → add to dashboard, variables, drilldown apps (queryless exploration).
- **Datadog:** correlations everywhere (click a point → related traces/logs/hosts), notebooks for investigations, powerpacks.
- **Honeycomb:** query builder that is the query language; BubbleUp; heatmap-first; every query has a permalink and history.
- **Axiom / Vercel Observability:** clean, fast defaults; little configuration; query-as-you-type.

Patterns that matter: explore → "save as panel" → dashboard in two clicks; every panel opens in explore; builder ↔ code round-trip (builder is a projection of the AST, never a separate model); metrics ↔ traces ↔ logs links driven by shared resource attributes and exemplars; global time picker with keyboard shortcuts and brush-zoom undo; `Cmd-K` for navigation, actions, and "ask"; assistant side panel that operates on the current dashboard draft with visible diffs.

---

## 6. Performance and testing

- **Budgets** [I]: app shell ≤ ~150 KB gzip JS before first paint; dashboard route ≤ ~120 KB more (uPlot, layout); editors, Plot, flame graph, service map, DuckDB each lazy chunks. CI fails on budget regression.
- **Core Web Vitals** "good" thresholds [T]: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1. Product targets: shell interactive < 1 s on repeat visits; first panel painted with (possibly coarse) data < 1 s warm, < 2.5 s cold; panels reserve their size so CLS is ~0; interactions (hover, brush) stay within one frame.
- **Techniques:** query only panels in or near the viewport (IntersectionObserver); concurrency limit with priority for visible panels; stale-while-revalidate from the client cache on navigation back; progressive refinement; decode and aggregate in Web Workers; OffscreenCanvas for heatmap/flame rendering where supported; `requestAnimationFrame`-batched cursor sync; avoid React re-render on data append (imperative chart handles); virtualize every list.
- **Testing:** Vitest for spec/patch/validation logic (shared between Worker and client); Storybook for panel kinds with fixed fixtures; Playwright for flows and visual regression (deterministic data, fixed DPR, fonts bundled; canvas snapshot with small tolerance); axe-core in CI; a performance fixture dashboard (50 panels, 500 series) with frame-time assertions; **agent evals** — a suite of authoring/reading tasks run against the MCP server, tracked for success rate and tokens per task. Tool descriptions and error messages are tuned against it.

---

## 7. Recommendations

### 7.1 Dashboard spec: `viz.dashboard/v1`

Decision [I]: **own a small spec whose structure is deliberately Perses/Grafana-v2-shaped** (map of panels, separate layout tree, `kind`-discriminated plugins), with maintained importers/exporters for Perses and Grafana (classic + v2).

Why not adopt Perses verbatim (as SigNoz did)? It is the strongest alternative: open governance, existing tooling, growing adoption. But the spec is pre-1.0 and mid-reorganization, lacks agent-oriented fields (intent, expectations, provenance, fragments with parameters, conditional visibility), and viz would inherit its release cadence. Keeping a lossless mapping for the common subset preserves the option to converge later. Why not Grafana v2? Verbose envelope, plugin-opaque options, Grafana-governed.

Principles: IDs are keys; defaults are implicit; layout is separate; queries are named; descriptions are required (lint error if missing); closed schema.

```json
{
  "apiVersion": "viz.dashboard/v1",
  "kind": "Dashboard",
  "metadata": {
    "id": "dsh_7f3k2m",
    "slug": "checkout-overview",
    "title": "Checkout — service overview",
    "tags": ["checkout", "tier-1"],
    "revision": 14,
    "provenance": {
      "author": { "type": "agent", "id": "claude-code", "onBehalfOf": "user:alice" },
      "message": "Add latency heatmap and split errors by route",
      "at": "2026-11-18T10:02:11Z"
    }
  },
  "spec": {
    "intent": "On-call view for checkout. Answers: is checkout healthy, and if not, is it traffic, errors, latency, or a dependency?",
    "time": { "from": "now-6h", "to": "now", "refresh": "30s" },
    "variables": {
      "env":   { "kind": "enum",  "values": ["prod", "staging"], "default": "prod" },
      "route": { "kind": "query", "query": { "lang": "promql", "expr": "label_values(http_server_requests_total{service=\"checkout\",env=\"$env\"}, route)" }, "multi": true, "default": "*" }
    },
    "queries": {
      "req_rate": {
        "lang": "promql",
        "expr": "sum by (route) (rate(http_server_requests_total{service=\"checkout\",env=\"$env\",route=~\"$route\"}[$__rate]))",
        "unit": "req/s", "legend": "{{route}}"
      },
      "err_ratio": {
        "lang": "promql",
        "expr": "sum(rate(http_server_requests_total{service=\"checkout\",env=\"$env\",status=~\"5..\"}[$__rate])) / sum(rate(http_server_requests_total{service=\"checkout\",env=\"$env\"}[$__rate]))",
        "unit": "ratio"
      },
      "slow_traces": {
        "lang": "traceql",
        "expr": "{ resource.service.name = \"checkout\" && duration > 2s }"
      }
    },
    "panels": {
      "p_rate": {
        "kind": "timeseries",
        "title": "Requests by route",
        "description": "Request throughput per route. Sudden drops matter more than peaks; compare with deploy annotations.",
        "queries": { "a": { "ref": "req_rate" } },
        "options": { "stack": true, "maxSeries": 20 }
      },
      "p_err": {
        "kind": "stat",
        "title": "Error ratio",
        "description": "Share of 5xx responses. SLO is 0.1%; above 1% is an incident.",
        "queries": { "a": { "ref": "err_ratio" } },
        "options": { "reduce": "last", "sparkline": true },
        "thresholds": [ { "above": 0.001, "level": "warn" }, { "above": 0.01, "level": "crit" } ]
      },
      "p_lat": {
        "kind": "heatmap",
        "title": "Latency distribution",
        "description": "Request duration histogram. A second band appearing above 1s usually means the payment dependency is slow.",
        "queries": { "a": { "lang": "promql", "expr": "sum(rate(http_server_duration_seconds{service=\"checkout\",env=\"$env\"}[$__rate]))", "unit": "s" } },
        "options": { "yScale": "log", "exemplars": true },
        "links": [ { "title": "Slow traces", "to": { "explore": { "ref": "slow_traces" } } } ]
      },
      "p_deps": {
        "kind": "fragment",
        "ref": "frag_dependency_red@3",
        "with": { "service": "checkout", "env": "$env" }
      },
      "p_slow": {
        "kind": "traces",
        "title": "Slowest traces",
        "description": "Traces over 2s in the selected range, slowest first.",
        "queries": { "a": { "ref": "slow_traces" } },
        "options": { "limit": 20, "sort": "duration desc" }
      }
    },
    "layout": {
      "kind": "sections",
      "sections": [
        { "id": "s_health", "title": "Health",
          "layout": { "kind": "auto", "minWidth": 360, "rowHeight": 240, "items": ["p_err", "p_rate", "p_lat"] } },
        { "id": "s_deps", "title": "Dependencies",
          "layout": { "kind": "auto", "items": ["p_deps"] } },
        { "id": "s_traces", "title": "Slow requests",
          "showIf": { "query": "err_ratio", "reduce": "last", "above": 0.001 },
          "layout": { "kind": "grid", "columns": 24, "items": [ { "panel": "p_slow", "x": 0, "y": 0, "w": 24, "h": 10 } ] } }
      ]
    },
    "annotations": {
      "deploys": { "source": "events", "filter": "kind=deploy service=checkout env=$env" }
    }
  }
}
```

Schema sketch (JSON Schema 2020-12, abbreviated):

```json
{
  "$id": "https://viz.dev/schema/dashboard/v1.json",
  "type": "object",
  "required": ["apiVersion", "kind", "metadata", "spec"],
  "additionalProperties": false,
  "properties": {
    "apiVersion": { "const": "viz.dashboard/v1" },
    "kind": { "const": "Dashboard" },
    "metadata": { "$ref": "#/$defs/Metadata" },
    "spec": {
      "type": "object", "additionalProperties": false, "required": ["panels", "layout"],
      "properties": {
        "intent":      { "type": "string", "maxLength": 600 },
        "time":        { "$ref": "#/$defs/Time" },
        "variables":   { "type": "object", "propertyNames": { "$ref": "#/$defs/Id" }, "additionalProperties": { "$ref": "#/$defs/Variable" } },
        "queries":     { "type": "object", "propertyNames": { "$ref": "#/$defs/Id" }, "additionalProperties": { "$ref": "#/$defs/Query" } },
        "panels":      { "type": "object", "propertyNames": { "$ref": "#/$defs/Id" }, "additionalProperties": { "$ref": "#/$defs/Panel" }, "maxProperties": 100 },
        "layout":      { "$ref": "#/$defs/Layout" },
        "annotations": { "type": "object", "additionalProperties": { "$ref": "#/$defs/AnnotationSource" } }
      }
    }
  },
  "$defs": {
    "Id": { "pattern": "^[a-z][a-z0-9_]{0,47}$" },
    "Query": {
      "type": "object", "required": ["lang", "expr"], "additionalProperties": false,
      "properties": {
        "lang": { "enum": ["promql", "traceql", "logs", "sql"] },
        "expr": { "type": "string" },
        "unit": { "$ref": "#/$defs/Unit" },
        "legend": { "type": "string" },
        "instant": { "type": "boolean" }
      }
    },
    "QueryOrRef": { "oneOf": [ { "$ref": "#/$defs/Query" }, { "type": "object", "required": ["ref"], "additionalProperties": false, "properties": { "ref": { "$ref": "#/$defs/Id" } } } ] },
    "Panel": {
      "oneOf": [
        { "$ref": "#/$defs/TimeseriesPanel" }, { "$ref": "#/$defs/StatPanel" }, { "$ref": "#/$defs/HeatmapPanel" },
        { "$ref": "#/$defs/TablePanel" }, { "$ref": "#/$defs/BarPanel" }, { "$ref": "#/$defs/LogsPanel" },
        { "$ref": "#/$defs/TracesPanel" }, { "$ref": "#/$defs/FlamePanel" }, { "$ref": "#/$defs/ServiceMapPanel" },
        { "$ref": "#/$defs/MarkdownPanel" }, { "$ref": "#/$defs/FragmentPanel" }
      ],
      "discriminator": { "propertyName": "kind" }
    },
    "Layout": { "oneOf": [ { "$ref": "#/$defs/AutoLayout" }, { "$ref": "#/$defs/GridLayout" }, { "$ref": "#/$defs/SectionsLayout" }, { "$ref": "#/$defs/TabsLayout" } ] }
  }
}
```

Notes:

- **Panel kinds v1:** timeseries, stat, heatmap, table, bar, logs, traces, flame, servicemap, markdown, fragment. Options per kind are small closed objects. An escape hatch `kind: "plot"` taking a restricted Vega-Lite-like `mark` + `encoding` covers the long tail without opening arbitrary code.
- **Fragments:** separately versioned resources (`viz.fragment/v1`) holding one or more panels plus parameters; referenced as `id@version` (pinned) or `id@latest`. This is the composition unit agents reuse.
- **Patches:** `PATCH /api/dashboards/{id}` with `Content-Type: application/json-patch+json` and `If-Match: "<revision>"`. Also offered: semantic operations in the MCP tool (`add_panel`, `move_panel`, `remove_panel`) that compile to JSON Patch, since layout-array edits are where raw patches go wrong.
- **Projections:** `?view=outline|spec|resolved|digest` and `Accept: text/markdown`. `resolved` inlines fragments and query refs.
- **Storage:** current spec + immutable revisions (R2 objects or D1 rows), index in D1; drafts with TTL. Git export is a later, additive feature.
- **Notebook/investigation** [I]: same panels and queries in a linear `viz.notebook/v1` (ordered cells: markdown, panel, finding) with absolute time pinned per cell. This is the natural output of an agent investigation; a notebook cell can be "promoted" to a dashboard panel.

### 7.2 Agent tool surface (MCP)

Stateless `/mcp` on a Worker via `createMcpHandler`; OAuth (CIMD preferred) mapped to tenant + scopes (`read`, `query`, `dashboards:write`, `dashboards:apply`). Keep the default toolset small; results default to compact text (markdown/TSV) with `structuredContent` for programmatic clients; every tool takes `max_tokens` and returns `truncated` + `cursor`.

| Tool | Purpose | Key params | Returns |
|---|---|---|---|
| `search_telemetry` | Find metrics, span attributes, log fields, services | `q`, `signal`, `limit` | name, type, unit, description, label keys, cardinality estimate |
| `describe_metric` | Detail for one metric/attribute | `name` | labels with top values, sample series, example queries |
| `validate_query` | Parse, type-check, estimate cost | `lang`, `expr` | ok / errors with position and suggestion; series and scan estimate |
| `query` | Run PromQL/TraceQL/logs/SQL | `lang`, `expr`, `from`, `to`, `format: digest\|table\|series`, `top_k` | digest by default; deep link |
| `search_dashboards` | Find dashboards and fragments | `q`, `tags`, `kind` | id, title, intent, usage, updated |
| `get_dashboard` | Read a dashboard | `id`, `view: outline\|spec\|resolved` | spec or outline, revision |
| `read_dashboard` | "Look at" it | `id`, `panels?`, `from`, `to`, `vars`, `image?` | per-panel digests, annotations, threshold states, deep links |
| `get_schema` | Spec schema and panel catalog | `kind?` | JSON Schema slice + one example (also as resources) |
| `write_dashboard` | Create or patch | `id?`, `spec?` or `ops[]`, `base_revision`, `dry_run` (default true), `mode: draft\|apply`, `message` | validation, lint, preview digests, diff summary, preview URL |
| `list_revisions` / `revert_dashboard` | History | `id`, `revision` | provenance log; new revision |
| `annotate` | Add a note/event on the timeline | `time`, `text`, `scope` | annotation id |
| `show_panel` (MCP App) | Render an interactive panel or dashboard inline in the host | `dashboard`/`panel` or ad-hoc `query` | `ui://viz/panel` resource + data; `visibility` includes `app` so the view can refetch on brush |

Resources: `viz://schema/dashboard/v1`, `viz://catalog/panels`, `viz://docs/promql`, `viz://docs/traceql`, `viz://dashboards/{id}`. Prompts: `investigate-service`, `build-service-dashboard`, `review-dashboard`. Opt-in toolsets later: alerts/SLOs, notebooks, bulk refactor via a Code Mode style `execute`.

The same operations back the REST API and the in-app assistant (AG-UI style event stream with JSON Patch deltas against the open draft), so there is one implementation of validate/preview/diff.

### 7.3 Frontend stack

| Layer | Choice | Main alternative | Tradeoff |
|---|---|---|---|
| Runtime/build | Vite 8 + Cloudflare Vite plugin; static assets + one Worker (Hono) for `/api`, `/mcp`, agent views | TanStack Start 1.0 full-stack | SPA is simpler and cheaper; Start adds SSR/server functions when needed, same router |
| UI framework | React 19 | SolidJS | Ecosystem and LLM fluency vs raw update performance; mitigated by keeping charts imperative |
| Routing/data | TanStack Router + TanStack Query | React Router 8 | Typed search params vs larger install base |
| Components | shadcn/ui on Base UI, Tailwind v4, cmdk, TanStack Table/Virtual | React Aria Components | Speed and ownership vs deepest a11y |
| Editors | CodeMirror 6 + Lezer grammars (PromQL, TraceQL, LogQL-like) | Monaco | Size and control vs familiarity |
| Layout | CSS grid for auto/read-only; react-grid-layout v2 for editing explicit grids | gridstack | React-native API vs framework-agnostic |
| Transport | Frame stream; Arrow IPC (Flechette) for large results; JSON for small; WebSocket (hibernating DO) for live tail; SSE for assistant | JSON everywhere | Simplicity vs memory/CPU at scale |
| State | URL + TanStack Query + small draft store with JSON Patch undo | Redux Toolkit | Less ceremony |

### 7.4 Chart library

- **Core:** vendored **uPlot** behind an internal `@viz/charts` interface (so the renderer is replaceable), with custom plugins for exemplars, annotations, thresholds, cursor sync, and band rendering.
- **Custom canvas:** heatmap, flame graph, trace waterfall minimap, service-map edges.
- **Long tail:** Observable Plot, lazy-loaded (bar, distribution, the `plot` escape-hatch panel), also usable for server-side SVG.
- **Alternative:** ECharts 6 for everything — less custom code, consistent theming, built-in sampling and zoom; costs bundle size and dense-line performance, and its configuration surface is harder to keep visually consistent. Reasonable if team capacity for custom renderers is short.
- **Revisit:** WebGPU renderers in 2027 when support and libraries mature.

### 7.5 UX principles for viz

1. **One model, three readers.** Every view has a visual form, a text/table form, and a structured form, all from the same spec and data. Humans, screen readers, and agents are peers.
2. **Explain itself.** No panel without a description and unit; no dashboard without an intent. Lint enforces it.
3. **Digest first, detail on demand** — for agents (token budgets) and humans (overview → drill-down).
4. **Everything is a link.** Any state (range, variables, focused panel, explore query, draft) is a URL that also resolves as markdown or JSON.
5. **Agents propose, humans dispose — configurable.** Drafts, visible diffs, one-click revert, provenance on every revision.
6. **Never show an unvalidated edit.** Dry-run with real data before anything is saved; "no data" is a first-class warning.
7. **Fast before complete.** Coarse data immediately, refine in place, never block the page on the slowest panel.
8. **Keyboard-first and dense,** with a command palette that covers navigation, actions, and asking.
9. **Correlate by default.** Any point, bar, or cell leads to the traces, logs, and deploys behind it.
10. **Builder and code are the same thing.** The builder is a view of the query AST.
11. **Stable visual identity.** Same series, same colour, everywhere; status colours reserved; dark and light equally supported.
12. **Reuse over creation.** Fragments and existing dashboards surface before "new"; agents are told what already exists.
13. **Honest rendering.** Downsampling preserves extremes; truncation, sampling, and partial results are always labelled.

---

## 8. Design implications for viz

- **Build the spec, validator, patcher, and digest generator as one isomorphic TypeScript package** used by the Worker API, the MCP server, the UI, and CI. This package is the product's core; the UI is one of its renderers.
- **Digest generation belongs next to the query engine,** not in the browser: it must work headlessly for MCP, alerts, markdown views, and scheduled reports. It needs cheap access to per-series statistics — design the query result frame to carry them (min/max/sum/count per series come nearly free during aggregation).
- **The query API must accept display hints** (`width_px`, `max_series`, `top_k by`, `format`) so downsampling and series capping happen server-side, and so progressive coarse-then-fine responses are possible. This has implications for rollups / Parquet layout in the storage design.
- **MCP being stateless removes the need for a Durable Object per agent session.** DOs remain for live tail fan-out, collaborative draft editing (if wanted), and rate limiting.
- **Ship an MCP App early.** A `ui://viz/panel` bundle that reuses the real chart components gives viz a presence inside Claude, ChatGPT, VS Code, and Cursor with one build. It needs a small, self-contained embed bundle and strict CSP `connectDomains` to the tenant API.
- **Multi-tenancy touches the frontend:** tenant in the URL path, per-tenant cache keys, per-tenant OAuth scopes for agents, protected dashboards (agents cannot apply directly), audit log of agent writes.
- **Interop is a feature:** importers for Grafana classic JSON, Grafana v2, and Perses are the adoption path; an exporter to Perses keeps the door open to convergence. PromQL-compatible HTTP API lets existing Grafana instances use viz as a data source during migration.
- **Agent evals are part of the test suite.** Tool descriptions, error messages, schema naming, and digest formats should be changed only with eval evidence.
- **Vendor risk register:** uPlot (unmaintained risk → vendored behind an interface), TanStack Start (new 1.0 → start with Router SPA), Perses spec (pre-1.0 → mapping, not dependency), MCP Apps (young → progressive enhancement; tools must work without UI).

---

## 9. Open questions / unverified

1. **Grafana v2 exact shapes** — the `apiVersion` string at GA (`dashboard.grafana.app/v2` vs `v2beta1`) and precise `PanelKind`/`vizConfig`/query-group JSON were not retrievable from docs pages this session; check the Swagger at `play.grafana.org/swagger?api=dashboard.grafana.app-v2beta1` or the Foundation SDK before writing the importer.
2. **Perses** — exact latest version (v0.53.1 vs v0.54.0 in different sources), the state of the new `perses/spec` repository, and whether a 1.0 is scheduled. Decide adopt-vs-map after reading the spec repo.
3. **uPlot** — last release March 2025; maintenance outlook unknown. The only 2026 benchmark found is from a competing vendor. Run our own benchmark (uPlot vs ECharts 6 vs ChartGPU) on representative panels (50 series × 1,500 points; 500 series; live append).
4. **Arrow streaming in the browser** — incremental IPC decoding from a `ReadableStream` with Flechette or Arrow JS was not confirmed. Also unresolved: where Arrow is produced (does the query engine emit Arrow natively, or must a Worker encode it?). Depends on the query-engine research.
5. **DuckDB-WASM size and 2.0 impact** — no authoritative 2026 bundle size found; DuckDB 2.0 was slated for autumn 2026.
6. **shadcn/ui Base UI default (July 2026)** — secondhand only.
7. **vinext 1.0 (September 2026)** and its production readiness — secondary sources only; not on the recommended path anyway.
8. **MCP Apps host support matrix** and behaviour differences (display modes, CSP enforcement, `tools/call` from the view) — the client list is from one secondary source; test on Claude, ChatGPT, VS Code.
9. **Image rendering on Workers** — cost and latency of Browser Rendering for panel screenshots vs an SVG + resvg-wasm path; whether Observable Plot runs in workerd with a DOM shim (unverified).
10. **Digest quality** — which statistics actually let models answer on-call questions correctly, and at what token cost; needs evals (digest vs TSV vs image vs image+digest).
11. **Agent write policy** — default for agents: draft-only or direct apply to unprotected dashboards? Needs a product decision; how MRTR elicitation behaves across hosts is untested.
12. **Collaborative editing** — is last-writer-wins with revision checks enough, or is a DO-coordinated shared draft (CRDT or OT over JSON Patch) needed for human + agent co-editing?
13. **PromQL/TraceQL dialect coverage** — whether upstream Lezer grammars match viz's engine dialect; `@prometheus-io/codemirror-promql` current status not re-verified.
14. **Honeycomb/Datadog MCP result shapes** for time series (binning, summaries) — not documented in what was found; a live `tools/list` and sample calls would show how incumbents shape digests.
15. Bundle-size figures for ECharts, Plotly, Monaco, uPlot and image token costs are training-knowledge approximations.

---

## 10. Sources

Dashboard models
- Grafana — Dynamic dashboards GA (2026-04-08): https://grafana.com/whats-new/2026-04-08-dynamic-dashboards-is-now-generally-available/
- Grafana — Schema v2 docs: https://grafana.com/docs/grafana/next/observability-as-code/schema-v2/ and layout schema: https://grafana.com/docs/grafana/next/observability-as-code/schema-v2/layout-schema
- Grafana — v2 Swagger: https://play.grafana.org/swagger?api=dashboard.grafana.app-v2beta1
- Grafana — Observability as code in Grafana 12: https://grafana.com/blog/2025/05/07/observability-as-code-grafana-12/
- Grafana 12.4 release: https://grafana.com/blog/grafana-12-4-release-all-the-latest-features
- Grafana Foundation SDK (dashboardv2): https://grafana.github.io/grafana-foundation-sdk/typescript/Reference/dashboardv2/object-Dashboard/
- Grafana community — provisioning v2 dashboards in Grafana 13: https://community.grafana.com/t/provisioning-in-grafana-13-with-v2-dashboards/163029
- mcp-grafana issue on v2/TabsLayout support: https://github.com/grafana/mcp-grafana/issues/712
- mcp-grafana: https://pkg.go.dev/github.com/grafana/mcp-grafana ; Grafana Cloud MCP: https://grafana.com/docs/grafana-cloud/machine-learning/assistant/configure/cloud-mcp/
- Grafana Labs press — six agentic tools GA (2026-07-27): https://grafana.com/press/2026/07/27/grafana-labs-ships-six-tools-that-power-agentic-operations-from-planning-to-production/
- Grafana Assistant GA (2025-10): https://www.businesswire.com/news/home/20251008705742/en/Grafana-Labs-Revolutionizes-AI-Powered-Observability-with-GA-of-Grafana-Assistant-and-Introduces-Assistant-Investigations
- Perses: https://github.com/perses/perses ; CNCF page: https://presentations.cncf.io/projects/perses/ ; v0.54.0 mirror: https://sourceforge.net/projects/perses.mirror/files/v0.54.0/
- Perses overview (The New Stack): https://thenewstack.io/perses-closes-the-observability-gap-with-declarative-dashboards/
- Dash0 Perses dashboard source format: https://dash0.com/docs/dash0/dashboards/reference-dashboard-source-format
- Chronosphere panel JSON: https://docs.chronosphere.io/observe/dashboards/panels/json-representation
- OpenSearch Dashboards RFC, Perses compatibility: https://github.com/opensearch-project/OpenSearch-Dashboards/issues/11591
- SigNoz — agent-native dashboards: https://signoz.io/blog/agent-native-observability-dashboard/ ; changelog 2026-07-29: https://signoz.io/changelog/2026-07-29-a-revamped-dashboard-experience-for-humans-and-agents-fafq47hx9thnrug7qtiapi0z/ ; v2 API: https://signoz.io/docs/dashboards/dashboards-v2-api/ ; upgrade guide: https://signoz.io/docs/operate/migration/upgrade-0-135/
- Datadog MCP tools: https://docs.datadoghq.com/mcp_server/tools/ ; DASH 2026 AI roundup: https://www.datadoghq.com/blog/dash-2026-new-feature-roundup-ai
- Datadog engineering — designing MCP tools for agents: https://www.datadoghq.com/blog/engineering/mcp-server-agent-tools/
- Honeycomb MCP tools: https://docs.honeycomb.io/integrations/mcp/tools ; MCP GA: https://www.honeycomb.io/blog/honeycomb-mcp-ga-support-bubbleup-heatmaps-histograms ; Canvas GA: https://www.honeycomb.io/blog/canvas-is-now-ga-ai-guided-observability-for-modern-teams
- Observable 2025 review: https://observablehq.com/blog/observable-2025-year-in-review

Agent protocols and generative UI
- MCP 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- SEP-1865 MCP Apps: https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp ; spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- MCP Apps client support overview (secondary): https://mcp.directory/blog/mcp-apps-spec-2026-when-should-your-server-render-ui
- OpenAI — MCP Apps in ChatGPT: https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt ; changelog: https://developers.openai.com/apps-sdk/changelog
- Cloudflare — The next generation of MCP: https://blog.cloudflare.com/mcp-v2/ ; Agents SDK v0.20 changelog: https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/ ; handler API: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- Cloudflare Code Mode MCP (InfoQ): https://infoq.com/news/2026/04/cloudflare-code-mode-mcp-server
- A2UI v0.9: https://developers.googleblog.com/en/a2ui-v0-9-generative-ui/ ; spec: https://a2ui.org/specification/v0.9-a2ui/ ; repo: https://github.com/google/A2UI ; CopilotKit summary: https://copilotkit.ai/blog/a2ui-whats-new-in-google-generative-ui-spec
- AG-UI on Bedrock AgentCore: https://aws.amazon.com/about-aws/whats-new/2026/03/amazon-bedrock-agentcore-runtime-ag-ui-protocol ; Microsoft: https://techcommunity.microsoft.com/blog/AzureDevCommunityBlog/building-interactive-agent-uis-with-ag-ui-and-microsoft-agent-framework/4488249 ; architecture: https://showcase.copilotkit.ai/ag-ui/concepts/architecture
- json-render overviews (secondary): https://dev.to/bean_bean/vercel-json-render-the-complete-guide-to-building-ai-generated-uis-in-2026-5089 ; https://pyshine.com/json-render-Generative-UI-Framework-Keeps-AI-on-a-Leash/
- Thesys C1: https://thesys.dev/blogs/generative-ui-architecture
- Cloudflare Markdown for Agents: https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents ; changelog: https://developers.cloudflare.com/changelog/2026-02-12-markdown-for-agents

Charting and data
- ECharts 6 features: https://echarts.apache.org/handbook/en/basics/release-note/v6-feature
- ApexCharts benchmark (vendor-authored; uPlot vs ECharts numbers): https://apexcharts.com/blog/javascript-chart-library-benchmark/
- uPlot package data: https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/uplot
- ChartGPU: https://github.com/ChartGPU/ChartGPU (overview: https://www.cssscript.com/webgpu-chart/)
- Flechette: https://idl.uw.edu/flechette/
- Mosaic: https://github.com/uwdata/mosaic ; Mosaic + DuckDB-WASM: https://idl.uw.edu/mosaic-framework-example/mosaic-duckdb-wasm
- DuckDB-WASM overview: https://duckdb.org/docs/lts/clients/wasm/overview
- `@grafana/lezer-traceql`: https://www.npmjs.com/package/@grafana/lezer-traceql

Frontend stack on Cloudflare
- Cloudflare Vite plugin: https://developers.cloudflare.com/workers/vite-plugin/ ; tutorial: https://developers.cloudflare.com/workers/vite-plugin/tutorial/
- Workers static assets SPA routing: https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
- TanStack Start on Cloudflare: https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/ ; TanStack Start 1.0: https://tanstack.com/blog/tanstack-start-1-0
- React Router v8: https://remix.run/blog/react-router-v8 ; changelog: https://reactrouter.com/changelog
- vinext: https://blog.cloudflare.com/vinext ; InfoQ: https://infoq.com/news/2026/03/cloudflare-vinext-experimental
- Base UI 1.0 (InfoQ): https://www.infoq.com/news/2026/02/baseui-v1-accessible ; shadcn + Base UI (secondary): https://blog.openreplay.com/shadcn-ui-radix-base-ui-switch/
- react-grid-layout v2 RFC: https://raw.githubusercontent.com/STRML/react-grid-layout/HEAD/rfcs/0001-v2-typescript-rewrite.md ; README: https://cdn.jsdelivr.net/npm/react-grid-layout@2.2.3/README.md
