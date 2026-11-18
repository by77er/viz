/** @viz/dashboard — the `viz.dashboard/v1` model. Pure TypeScript, zero runtime dependencies. */
export * from './types.ts'
export { dashboardSchema, PANEL_CATALOG, ID_PATTERN, DURATION_PATTERN, TIME_PATTERN, type JsonSchema } from './schema.ts'
export { getSchema, EXAMPLE_DASHBOARD, SCHEMA_KINDS, type SchemaKind, type SchemaSlice } from './get-schema.ts'
export { validate, isDashboard, walkLayout, type LayoutVisitor } from './validate.ts'
export { validateAgainst } from './schema-validate.ts'
export { lint, LINT_RULES, type LintOptions } from './lint.ts'
export { applyOps, applyPatch, diff, summarizeDiff, type PatchOp, type PatchError, type ApplyOpsResult, type ApplyPatchOptions, type ApplyPatchResult } from './patch.ts'
export { revisionOf, sha256Hex } from './revision.ts'
export { canonicalJson, deepEqual, parsePointer, pointer, escapeToken, unescapeToken } from './json.ts'
export { resolve, type ResolveOptions, type ResolvedDashboard, type ResolvedPanel, type ResolvedQuery, type ResolvedLayout, type ResolvedRowItem } from './resolve.ts'
export { findVariables, substitute, escapeRegex, escapeString, isSafeBare, BUILTIN_VARIABLES, type Binding, type VarRef, type RefContext, type BuiltinVariable } from './expr.ts'
export {
  digestPanel, digestDashboard, renderDigest, thresholdState, robustZ, formatNumber,
  type DigestOptions, type PanelDigest, type SeriesDigest, type Trend, type DashboardDigest, type RenderOptions, type RenderedDigest, type PromData,
} from './digest.ts'
export { fromGrafana, type ImportResult, type ImportWarning } from './grafana.ts'
