/**
 * The `viz.dashboard/v1` JSON Schema (draft 2020-12). Closed: every object
 * has `additionalProperties: false` (or is a map with constrained keys).
 *
 * This object is the single source of truth for structural validation: the
 * validator in `schema-validate.ts` interprets it at runtime (no code
 * generation, so it runs in Workers), and `schema/viz.dashboard.v1.schema.json`
 * is a generated copy (a test fails if it drifts).
 *
 * Only this keyword subset is used, and it is all the interpreter supports:
 * type, const, enum, required, properties, additionalProperties,
 * propertyNames, pattern, minLength, maxLength, minimum, maximum, items,
 * minItems, maxItems, uniqueItems, minProperties, maxProperties, oneOf, $ref.
 */
import { LEVELS, PANEL_KINDS, QUERY_LANGS, REDUCERS, UNITS } from './types.ts'

export const ID_PATTERN = '^[a-z][a-z0-9_]{0,47}$'
export const DURATION_PATTERN = '^([0-9]+(ms|s|m|h|d|w|y))+$'
export const TIME_PATTERN =
  '^(now(-([0-9]+(ms|s|m|h|d|w|y))+)?|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2}))$'

export type JsonSchema = { readonly [k: string]: unknown }

const str = (min: number, max: number, description?: string) => ({
  type: 'string',
  minLength: min,
  maxLength: max,
  ...(description ? { description } : {}),
})
const ref = (name: string) => ({ $ref: `#/$defs/${name}` })
const idMap = (of: string, max: number, description: string) => ({
  type: 'object',
  description,
  propertyNames: ref('Id'),
  additionalProperties: ref(of),
  maxProperties: max,
})

const panelCommon = {
  title: str(1, 120, 'Short human title. Not the query text.'),
  description: str(1, 600, 'What the panel shows, how to read it, and what bad looks like.'),
}
const queriesProp = (max: number) => ({
  type: 'array',
  description: 'Ids of named queries (keys of `queries`).',
  items: ref('Id'),
  minItems: 1,
  maxItems: max,
  uniqueItems: true,
})
const thresholds = {
  type: 'array',
  description: 'Value thresholds. The worst breached level is the panel state.',
  items: ref('Threshold'),
  maxItems: 8,
}

export const dashboardSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://viz.dev/schema/dashboard/v1.json',
  title: 'viz.dashboard/v1',
  type: 'object',
  additionalProperties: false,
  required: ['apiVersion', 'metadata', 'panels', 'layout'],
  properties: {
    apiVersion: { const: 'viz.dashboard/v1' },
    metadata: ref('Metadata'),
    time: ref('TimeRange'),
    variables: idMap('Variable', 32, 'Dashboard variables, referenced in query expressions as $name or ${name}.'),
    queries: idMap('Query', 200, 'Named queries. Panels reference them by id.'),
    panels: idMap('Panel', 100, 'Panels keyed by stable id. Position lives in `layout`, not here.'),
    layout: ref('Layout'),
    fragments: idMap('Fragment', 32, 'Reusable groups of queries + panels + layout with parameters.'),
  },
  $defs: {
    Id: { type: 'string', pattern: ID_PATTERN, description: 'Lowercase letter, then lowercase letters, digits or _. Max 48 chars.' },
    Unit: { enum: [...UNITS] },
    Duration: { type: 'string', pattern: DURATION_PATTERN, description: 'Prometheus duration, e.g. 30s, 5m, 1h30m.' },
    Metadata: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'intent'],
      properties: {
        id: ref('Id'),
        title: str(1, 120),
        intent: str(1, 600, 'What question this dashboard answers, and for whom.'),
        tags: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.:-]{0,39}$' }, maxItems: 16, uniqueItems: true },
      },
    },
    TimeRange: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', pattern: TIME_PATTERN, description: 'now, now-6h, or an RFC 3339 timestamp.' },
        to: { type: 'string', pattern: TIME_PATTERN },
        refresh: ref('Duration'),
      },
    },
    Variable: {
      oneOf: [ref('EnumVariable'), ref('QueryVariable'), ref('TextVariable'), ref('IntervalVariable')],
    },
    EnumVariable: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'values'],
      properties: {
        kind: { const: 'enum' },
        label: str(1, 60),
        description: str(1, 300),
        values: { type: 'array', items: str(1, 200), minItems: 1, maxItems: 200, uniqueItems: true },
        multi: { type: 'boolean', description: 'Several values may be selected; use with =~ matchers only.' },
        includeAll: { type: 'boolean', description: 'Offer "*" (all), which resolves to the regex .*' },
        default: ref('VariableDefault'),
      },
    },
    QueryVariable: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'query'],
      properties: {
        kind: { const: 'query' },
        label: str(1, 60),
        description: str(1, 300),
        query: {
          type: 'object',
          additionalProperties: false,
          required: ['lang', 'expr'],
          properties: { lang: { enum: [...QUERY_LANGS] }, expr: str(1, 2000) },
        },
        multi: { type: 'boolean' },
        includeAll: { type: 'boolean' },
        default: ref('VariableDefault'),
      },
    },
    TextVariable: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { const: 'text' },
        label: str(1, 60),
        description: str(1, 300),
        default: str(0, 200),
      },
    },
    IntervalVariable: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'values'],
      properties: {
        kind: { const: 'interval' },
        label: str(1, 60),
        description: str(1, 300),
        values: { type: 'array', items: ref('Duration'), minItems: 1, maxItems: 32, uniqueItems: true },
        default: ref('Duration'),
      },
    },
    VariableDefault: {
      oneOf: [str(0, 200), { type: 'array', items: str(1, 200), minItems: 1, maxItems: 200, uniqueItems: true }],
    },
    Query: {
      type: 'object',
      additionalProperties: false,
      required: ['lang', 'expr'],
      properties: {
        lang: { enum: [...QUERY_LANGS] },
        expr: str(1, 4000, 'Query text. Variables: $name or ${name}; built-ins $__rate, $__interval, $__range.'),
        legend: str(1, 200, 'Series name template, e.g. {{route}}.'),
        instant: { type: 'boolean' },
      },
    },
    Threshold: { oneOf: [ref('ThresholdAbove'), ref('ThresholdBelow')] },
    ThresholdAbove: {
      type: 'object',
      additionalProperties: false,
      required: ['above', 'level'],
      properties: { above: { type: 'number' }, level: { enum: [...LEVELS] }, label: str(1, 60) },
    },
    ThresholdBelow: {
      type: 'object',
      additionalProperties: false,
      required: ['below', 'level'],
      properties: { below: { type: 'number' }, level: { enum: [...LEVELS] }, label: str(1, 60) },
    },
    Panel: {
      oneOf: [ref('TimeseriesPanel'), ref('StatPanel'), ref('TablePanel'), ref('HeatmapPanel'), ref('TextPanel')],
    },
    TimeseriesPanel: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title', 'description', 'unit', 'queries'],
      properties: {
        kind: { const: 'timeseries' },
        ...panelCommon,
        unit: ref('Unit'),
        queries: queriesProp(8),
        options: {
          type: 'object',
          additionalProperties: false,
          properties: {
            style: { enum: ['line', 'area', 'bars'] },
            stack: { type: 'boolean' },
            yScale: { enum: ['linear', 'log'] },
            yMin: { type: 'number' },
            yMax: { type: 'number' },
            maxSeries: { type: 'integer', minimum: 1, maximum: 500 },
            legend: { enum: ['list', 'table', 'hidden'] },
          },
        },
        thresholds,
      },
    },
    StatPanel: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title', 'description', 'unit', 'queries'],
      properties: {
        kind: { const: 'stat' },
        ...panelCommon,
        unit: ref('Unit'),
        queries: queriesProp(4),
        options: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reduce: { enum: [...REDUCERS] },
            sparkline: { type: 'boolean' },
            decimals: { type: 'integer', minimum: 0, maximum: 6 },
          },
        },
        thresholds,
      },
    },
    TablePanel: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title', 'description', 'queries'],
      properties: {
        kind: { const: 'table' },
        ...panelCommon,
        unit: ref('Unit'),
        queries: queriesProp(12),
        options: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reduce: { enum: [...REDUCERS] },
            columns: {
              type: 'array',
              maxItems: 12,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['query'],
                properties: { query: ref('Id'), title: str(1, 60), unit: ref('Unit') },
              },
            },
            sortBy: ref('Id'),
            sortDir: { enum: ['asc', 'desc'] },
            limit: { type: 'integer', minimum: 1, maximum: 1000 },
          },
        },
        thresholds,
      },
    },
    HeatmapPanel: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title', 'description', 'unit', 'queries'],
      properties: {
        kind: { const: 'heatmap' },
        ...panelCommon,
        unit: ref('Unit'),
        queries: queriesProp(1),
        options: {
          type: 'object',
          additionalProperties: false,
          properties: {
            yScale: { enum: ['linear', 'log'] },
            colorScale: { enum: ['linear', 'sqrt', 'log'] },
            exemplars: { type: 'boolean' },
          },
        },
      },
    },
    TextPanel: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title', 'content'],
      properties: {
        kind: { const: 'text' },
        title: panelCommon.title,
        description: panelCommon.description,
        content: str(1, 8000, 'Markdown.'),
      },
    },
    Layout: { oneOf: [ref('RowsLayout'), ref('GridLayout')] },
    RowsLayout: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'rows'],
      properties: {
        kind: { const: 'rows' },
        rows: { type: 'array', items: ref('Row'), maxItems: 50 },
      },
    },
    Row: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        title: str(1, 120),
        height: { type: 'integer', minimum: 40, maximum: 2000 },
        items: { type: 'array', items: ref('RowItem'), minItems: 1, maxItems: 24 },
      },
    },
    RowItem: {
      description: 'A panel id, a panel with a span, a fragment instance, or a nested layout.',
      oneOf: [ref('Id'), ref('PanelItem'), ref('FragmentUse'), ref('RowsLayout'), ref('GridLayout')],
    },
    PanelItem: {
      type: 'object',
      additionalProperties: false,
      required: ['panel'],
      properties: { panel: ref('Id'), span: ref('Span') },
    },
    Span: { type: 'integer', minimum: 1, maximum: 12, description: 'Width in twelfths of the row. Default: equal split.' },
    FragmentUse: {
      type: 'object',
      additionalProperties: false,
      required: ['fragment', 'as'],
      properties: {
        fragment: ref('Id'),
        as: ref('Id'),
        with: {
          type: 'object',
          description: 'Arguments by parameter name: a literal string, or exactly one variable reference ($env).',
          propertyNames: ref('Id'),
          additionalProperties: str(0, 200),
          maxProperties: 16,
        },
        span: ref('Span'),
      },
    },
    GridLayout: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'items'],
      properties: {
        kind: { const: 'grid' },
        columns: { type: 'integer', minimum: 1, maximum: 48, description: 'Default 24.' },
        items: { type: 'array', items: ref('GridItem'), maxItems: 100 },
      },
    },
    GridItem: {
      type: 'object',
      additionalProperties: false,
      required: ['panel', 'x', 'y', 'w', 'h'],
      properties: {
        panel: ref('Id'),
        x: { type: 'integer', minimum: 0, maximum: 47 },
        y: { type: 'integer', minimum: 0, maximum: 10000 },
        w: { type: 'integer', minimum: 1, maximum: 48 },
        h: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    Fragment: {
      type: 'object',
      additionalProperties: false,
      required: ['description', 'panels', 'layout'],
      properties: {
        description: str(1, 600, 'What the fragment is for and when to reuse it.'),
        params: {
          type: 'object',
          propertyNames: ref('Id'),
          maxProperties: 16,
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: { description: str(1, 300), default: str(0, 200) },
          },
        },
        queries: idMap('Query', 50, 'Queries local to the fragment. They may use only the fragment parameters and built-ins.'),
        panels: idMap('Panel', 50, 'Panels local to the fragment; they reference the fragment queries.'),
        layout: ref('Layout'),
      },
    },
  },
} as const satisfies JsonSchema

/** One line per panel kind; returned by `getSchema()` as the panel catalog. */
export const PANEL_CATALOG: Record<(typeof PANEL_KINDS)[number], string> = {
  timeseries: 'Lines/areas/bars over time. Requires unit and description. Options: style, stack, yScale, yMin, yMax, maxSeries, legend. Thresholds drawn as bands.',
  stat: 'One reduced number per series (last/mean/min/max/sum), optional sparkline. Requires unit and description; give it thresholds.',
  table: 'One row per series, one column per query, reduced over the range. Options: columns (title, unit), sortBy, sortDir, limit.',
  heatmap: 'Distribution over time from one histogram query. Requires unit and description. Options: yScale, colorScale, exemplars.',
  text: 'Markdown note: context, runbook links, how to read the dashboard. No queries.',
}
