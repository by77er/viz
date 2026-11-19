// Literal values, read with real parsers: css-tree for CSS (component CSS, <style> blocks, style attributes in either quote, CSS written by
// script), parse5 for HTML. A value is a literal if anything in it, at any depth (inside calc(), var() fallbacks, colour functions,
// gradients, filters, conditions), is a design value written out instead of taken from a token. What is allowed, and why:
//   0 of any unit (no amount); 1lh (the current line's own height, used to centre a mark on a first line); whole numbers (a count, an order,
//   a multiple or a fraction 1/n of a token inside calc()); integer fr (proportions of a layout); 0%, 50%, 100% only where they are geometry
//   (sizes, positions, translate, background-position, clip-path, the select's two hard-stop gradients); transparent and currentColor;
//   z-index of two digits; line-height: 1; linear only in an animation driven by a scroll timeline (it maps scroll to the edge, not time);
//   data custom properties (DATA_PROPS) in style attributes; in script, values built at run time (a ${…} or a concatenation).
// Everything else is reported, by kind. A line containing `token-lint-ignore: <reason>` is skipped; the reason is required.
// v7 (the v6 review's mutants Y1 to Y20): names are read unescaped (`\72 ed` is red); the keyword widths thin, medium and thick are
// lengths; small capitals in font-variant and font-feature-settings are capitals; an animation that repeats (infinite, or a count above
// one) loops and a keyframe that rotates is a spinner; declarations in every at-rule (@property, @font-face, @page) and in nested rules
// are walked; an emoji anywhere (a content string, text, an attribute, script) is reported; SVG presentation attributes (fill="red",
// stroke-width="3") are values; a media attribute (<style media>, <link media>, <source media>) and matchMedia() are conditions; script
// that writes style by Object.assign(el.style, …), el.animate(…), setAttribute('style' | a presentation attribute, …) or style['…'] is
// read as CSS. tools/audit.mjs then checks, as rendered, that every colour, length, duration and opacity on a page comes from a token,
// whatever its spelling.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const csstree = require('css-tree'), parse5 = require('parse5')
export { csstree }

const NAMED = new Set('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext highlight highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext'.split(' '))
const COLOUR_FN = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|device-cmyk|contrast-color)$/i
const GRADIENT_FN = /^(repeating-)?(linear|radial|conic)-gradient$/i
const FILTER_FN = /^(blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|opacity|saturate|sepia)$/i
const TIMING_FN = /^(cubic-bezier|steps|linear)$/i
const TIMING_KW = new Set(['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'])
const TIMING_PROPS = /^(transition|transition-timing-function|animation|animation-timing-function)$/
const UNIT_KIND = (u) => (/^(s|ms)$/.test(u) ? 'duration' : /^(deg|grad|rad|turn)$/.test(u) ? 'angle' : /^(hz|khz)$/.test(u) ? 'frequency' : /^(dpi|dpcm|dppx|x)$/.test(u) ? 'resolution' : 'length')
const GEOMETRY_PCT = /^(width|height|min-width|min-height|max-width|max-height|inline-size|block-size|min-inline-size|max-inline-size|inset|inset-inline|inset-block|top|right|bottom|left|transform|translate|background-position|background-size|clip-path|margin|margin-left|margin-right|margin-top|margin-bottom|margin-inline|margin-block|flex|flex-basis|transform-origin|grid-template-columns|grid-template-rows|grid-auto-columns)$/
const HOVER_OK = /^(color|background|background-color|border-color|border-(top|right|bottom|left|inline|block)-color|text-decoration|text-decoration-(line|color|thickness|style)|outline-color|fill|stroke|cursor|transition|transition-duration)$/
// Custom properties that carry data, not design: a waterfall span's start and length as fractions of its trace, a chart's legend rows and note
// lines from its last result. Allowed in style attributes and script only, where data is written; never in a stylesheet.
const DATA_PROPS = new Set(['--at', '--len', '--legend-rows', '--legend-notes'])
const SIZE_KW = /^(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$/

const unesc = (x) => { try { return csstree.ident.decode(String(x)) } catch { return String(x) } }
export const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[\u{1F000}-\u{1FAFF}]/u
const SMALL_CAPS = /^(small-caps|all-small-caps|petite-caps|all-petite-caps|unicase|titling-caps)$/
const WIDTH_KW = /^(thin|medium|thick)$/
// SVG presentation attributes, read as the property of the same name (a bare number in a length attribute is a length in px)
export const PRESENTATION = { fill: 'colour', stroke: 'colour', 'stop-color': 'colour', 'flood-color': 'colour', 'lighting-color': 'colour', color: 'colour', 'stroke-width': 'length', 'font-size': 'length', 'stroke-dasharray': 'length', 'stroke-dashoffset': 'length', 'letter-spacing': 'length', 'word-spacing': 'length', opacity: 'opacity', 'fill-opacity': 'opacity', 'stroke-opacity': 'opacity', 'stop-opacity': 'opacity', 'flood-opacity': 'opacity', 'font-weight': 'weight', 'font-family': 'typeface', 'font-style': 'italic' }
// Walks a value AST; `report(kind, text)` for each literal. ctx: { prop, rule (selector text), scroll (the rule has a scroll timeline), select (the
// select's arrow rule), tokens (Set of colour token names) }
function lintValue(node, ctx, report) {
  const prop = ctx.prop, g = (n) => csstree.generate(n)
  const visit = (n, fns) => {
    if (!n) return
    switch (n.type) {
      case 'Dimension': { const u = unesc(n.unit).toLowerCase(), v = +n.value
        if (v === 0) return; if (u === 'lh' && v === 1) return; if (u === 'fr' && Number.isInteger(v)) return
        report(UNIT_KIND(u), n.value + n.unit); return }
      case 'Percentage': { const v = +n.value, inGradient = fns.some((f) => GRADIENT_FN.test(f))
        if (fns.some((f) => COLOUR_FN.test(f))) { report('percentage', n.value + '%'); return }
        if ([0, 50, 100, -50, -100].includes(v) && (GEOMETRY_PCT.test(prop) || (inGradient && ctx.select) || (prop === 'font-size' && v === 100))) return
        report('percentage', n.value + '%'); return }
      case 'Number': { const v = +n.value
        if (prop === 'font-weight') { report('weight', n.value); return }
        if (/line-clamp$/.test(prop)) { report('line clamp', n.value); return }
        if (prop === 'line-height') { if (v !== 1) report('line height', n.value); return }
        if (prop === 'z-index') { if (!Number.isInteger(v) || Math.abs(v) > 99) report('z-index', n.value); return }
        if (prop === 'opacity' || prop === 'zoom') { report(prop, n.value); return }
        if (/^animation(-iteration-count)?$/.test(prop) && v > 1) { report('loop', `${prop}: ${n.value} repeats: nothing loops (Motion)`); return }
        if (!Number.isInteger(v)) report('number', n.value); return }
      case 'Hash': report('colour', '#' + unesc(n.value)); return
      case 'Identifier': { const id = unesc(n.name).toLowerCase(), shown = id === n.name.toLowerCase() ? n.name : `${n.name} (${id})`
        if (id.startsWith('--')) return // a custom property's name, inside var()
        if (NAMED.has(id)) { report('colour', shown); return }
        if (/^(border|outline|column-rule)(-(top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?(-width)?$/.test(prop) && WIDTH_KW.test(id)) { report('length', `${shown} (a keyword width)`); return }
        if (/^font-variant(-caps)?$/.test(prop) && SMALL_CAPS.test(id)) { report('capitals', shown); return }
        if (/^animation(-iteration-count)?$/.test(prop) && id === 'infinite') { report('loop', `${prop}: infinite: nothing loops, and a spinner never covers a wait (Motion; owner's direction)`); return }
        if (prop === 'font-weight' && !/^(inherit|initial|unset)$/.test(id)) { report('weight', n.name); return }
        if (prop === 'font-size' && SIZE_KW.test(id)) { report('size', n.name); return }
        if (prop === 'font-style' && /^(italic|oblique)$/.test(id)) { report('italic', n.name); return }
        if (prop === 'text-transform' && id !== 'none') { report('capitals', n.name); return }
        if (prop === 'font-variant-caps' && id !== 'normal') { report('capitals', n.name); return }
        if (prop === 'font-family' && !/^(inherit|initial|unset)$/.test(id)) { report('typeface', n.name); return }
        if (TIMING_PROPS.test(prop) && TIMING_KW.has(id) && !(id === 'linear' && ctx.scroll)) { report('easing', n.name); return }
        return }
      case 'String': if (prop === 'font-family') report('typeface', n.value)
        if (EMOJI.test(n.value)) report('emoji', `"${n.value}": no emoji (Words)`)
        if (prop === 'font-feature-settings' && /^(smcp|c2sc|pcap|c2pc|unic|titl)$/.test(n.value)) report('capitals', `"${n.value}"`)
        return
      case 'Url': report('asset', g(n)); return
      case 'Raw': { const t = n.value.trim(); if (!t) return; try { visit(csstree.parse(t, { context: 'value' }), fns) } catch { report('unparsed', t) } return }
      case 'Function': { const f = unesc(n.name).toLowerCase()
        if (COLOUR_FN.test(f)) report('colour', g(n).slice(0, 60))
        else if (GRADIENT_FN.test(f) && !ctx.select) report('gradient', g(n).slice(0, 60))
        else if (FILTER_FN.test(f) && /filter/.test(prop)) { /* reported by the property */ }
        else if (TIMING_FN.test(f) && TIMING_PROPS.test(prop)) report('easing', g(n).slice(0, 60))
        else if (/^scale/.test(f) || /^(rotate|skew)/.test(f)) { /* numbers and angles inside are reported as such */ }
        n.children?.forEach((c) => visit(c, [...fns, f])); return }
      default: n.children?.forEach?.((c) => visit(c, fns))
    }
  }
  visit(node, [])
}

// Property rules: whole properties that are a literal by what they do.
function lintProperty(prop, value, ctx, report) {
  const text = csstree.generate(value).trim(), id = text.toLowerCase()
  if (prop === 'opacity') report('opacity', `opacity: ${text}`)
  if (/^(filter|backdrop-filter|-webkit-backdrop-filter)$/.test(prop) && id !== 'none') report('filter', `${prop}: ${text}`)
  if (prop === 'mix-blend-mode' && id !== 'normal') report('blend', `${prop}: ${text}`)
  if (prop === 'text-shadow' && id !== 'none') report('shadow', `text-shadow: ${text}`)
  if (prop === 'letter-spacing' && !/^(0|normal|inherit|var\(--text-[a-z-]+-track\))$/.test(id)) report('tracking', `letter-spacing: ${text}`)
  if (/^border(-(top|bottom)-(left|right)|-(start|end)-(start|end))?-radius$/.test(prop)) for (const part of (value.children?.toArray?.() ?? []).filter((c) => c.type !== 'WhiteSpace' && !(c.type === 'Operator' && c.value === '/')).map((c) => csstree.generate(c))) if (!/^(0|inherit|var\(--radius-\d\))$/.test(part)) { report('radius', `${prop}: ${text} (radii are radius tokens; nothing is fully rounded)`); break }
  if (prop === 'font-size' && !/^(inherit|var\(--text-[a-z-]+-size\)|max\(var\(--text-[a-z-]+-size\),calc\(100%\*var\(--qty-scale\)\)\))$/.test(id.replace(/\s+/g, ''))) report('size', `font-size: ${text} (a type style's size, nothing computed: micro is the smallest text)`)
  if (prop === 'font' && !/^(inherit|var\(--text-[a-z-]+\))$/.test(id)) report('size', `font: ${text}`)
  if (prop === 'box-shadow' || prop === '-webkit-box-shadow') {
    const layers = []; let cur = []; value.children?.forEach((c) => { if (c.type === 'Operator' && c.value === ',') { layers.push(cur); cur = [] } else if (c.type !== 'WhiteSpace') cur.push(c) }); layers.push(cur)
    for (const l of layers) { const t = l.map((c) => csstree.generate(c)).join(' ').toLowerCase(); if (/^(none|var\(--shadow-overlay\)|inherit)$/.test(t)) continue
      const lengths = l.filter((c) => !(c.type === 'Identifier' && /^(inset|currentcolor|transparent)$/i.test(c.name)) && !(c.type === 'Function' && c.name === 'var' && ctx.tokens.has(c.children.first?.name?.slice(2))))
      if (lengths.length >= 3 && !/^0([a-z%]*)$/.test(csstree.generate(lengths[2]))) report('shadow', `box-shadow layer "${t}": blurred, and not shadow-overlay, the one shadow`) }
  }
}

// One CSS text (a stylesheet, a <style> block, or a declaration list from a style attribute or script). Returns the parsed rules for the
// structural checks: [{ sel: [selector text], decls: [[prop, value text, valueNode, important]], cond: [prelude text], line }].
export function lintCss(text, { file, line0 = 0, report, tokens, declarationsOnly = false, breakpoints = null, sourceLines = text.split('\n') }) {
  const rules = []
  let ast
  try { ast = csstree.parse(declarationsOnly ? `x{${text}}` : text, { positions: true, parseCustomProperty: true, onParseError: (e) => report('unparsed', file, line0 + (e.line ?? 1), [e.formattedMessage?.split('\n')[0] ?? e.message]) }) } catch (e) { report('unparsed', file, line0 + 1, [e.message]); return rules }
  const ignored = (line) => { const src = sourceLines[line - 1] ?? ''; if (!/token-lint-ignore/.test(src)) return false; if (!/token-lint-ignore:\s*\S/.test(src)) report('ignore-without-reason', file, line0 + line, ['token-lint-ignore']); return true }
  // one declaration list: a rule's, an at-rule's (@property, @font-face, @page) or a nested rule's
  const declare = (node, sel, cond, at) => {
    const line = node.loc.start.line, decls = []
    const scroll = node.block.children.some((d) => d.type === 'Declaration' && d.property === 'animation-timeline' && /scroll|view/.test(csstree.generate(d.value)))
    const select = sel.every((x) => /^\.vz-select$/.test(x))
    node.block.children.forEach((d) => {
      if (d.type !== 'Declaration') return
      const prop = unesc(d.property).toLowerCase(), dline = d.loc.start.line; decls.push([prop, csstree.generate(d.value).trim(), d.value, !!d.important])
      if (ignored(dline) || (declarationsOnly && DATA_PROPS.has(prop))) return
      const hits = [], r = (kind, what) => hits.push([kind, what])
      lintValue(d.value, { prop, scroll, select, tokens }, r); lintProperty(prop, d.value, { tokens }, r)
      if (at === 'keyframes' && /^(transform|rotate)$/.test(prop) && /rotate/i.test(csstree.generate(d.value))) r('spinner', `${prop}: ${csstree.generate(d.value)} in @keyframes: a turning mark is a spinner, which never covers a wait (owner's direction; Responsiveness and feedback)`)
      if (sel.some((x) => x.includes(':hover')) && !HOVER_OK.test(prop) && !prop.startsWith('--')) r('hover', `${prop} under :hover in "${sel.find((x) => x.includes(':hover'))}": hover may change colour only; nothing appears, moves or resizes on hover (a phone has none)`)
      for (const [kind, what] of hits) report(kind, file, line0 + dline, [`${prop}: ${what}`])
    })
    rules.push({ sel, decls, cond, line: line0 + line })
    // nested rules (CSS nesting): their selectors resolved against this one
    node.block.children.forEach((c) => { if (c.type === 'Rule') rule(c, sel, cond, at); else if (c.type === 'Atrule') atrule(c, sel, cond) })
  }
  const split = (text) => { const out = []; let d = 0, cur = ''; for (const ch of text) { if ('(['.includes(ch)) d++; else if (')]'.includes(ch)) d--; if (ch === ',' && !d) { out.push(cur.trim()); cur = '' } else cur += ch } out.push(cur.trim()); return out } // commas at depth 0 only (a :is(a, b) is one selector)
  const rule = (node, parent, cond, at) => {
    const own = split(csstree.generate(node.prelude)), sel = parent ? parent.flatMap((p) => own.map((x) => (x.includes('&') ? x.replace(/&/g, p) : `${p} ${x}`))) : own
    declare(node, sel, cond, at)
  }
  const atrule = (node, parent, cond) => {
    const pre = node.prelude ? csstree.generate(node.prelude) : '', name = unesc(node.name).toLowerCase()
    if (/^(media|container|supports)$/.test(name) && node.prelude && !ignored(node.loc.start.line)) csstree.walk(node.prelude, (n) => {
      if (n.type === 'Dimension') { const u = unesc(n.unit).toLowerCase(), v = +n.value; if (u !== 'px' || (breakpoints && !breakpoints.has(v))) report('breakpoint', file, line0 + node.loc.start.line, [`@${node.name} ${pre}: ${n.value}${n.unit} is not a breakpoint token (or one less)`]) } })
    if (!node.block) return
    const c = [...cond, `@${node.name} ${pre}`]
    // an at-rule whose block holds declarations (@property, @font-face, @page, @counter-style), or declarations nested in a conditional
    if (node.block.children.some((d) => d.type === 'Declaration')) declare(node, parent ?? [`@${node.name} ${pre}`.trim()], c, name)
    else node.block.children.forEach((x) => { if (x.type === 'Rule') rule(x, parent, c, name === 'keyframes' ? 'keyframes' : null); else if (x.type === 'Atrule') atrule(x, parent, c) })
  }
  const walk = (block, cond) => block.children.forEach((node) => { if (node.type === 'Atrule') atrule(node, null, cond); else if (node.type === 'Rule') rule(node, null, cond, null) })
  walk(ast, [])
  return rules
}

// Script: colours anywhere in code; CSS written as strings (a style attribute inside a template, cssText, style.<prop> = …, setProperty)
// linted as CSS, with each ${…} read as a value computed at run time; in strings, lengths and durations. Comments are not code.
export function lintScript(text, { file, line0 = 0, report, tokens, test = false, breakpoints = null }) {
  const lines = text.split('\n'), strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1')
  const code = strip(text), codeLines = code.split('\n'), lineAt = (i) => code.slice(0, i).split('\n').length
  const runtime = (s) => s.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}(?:px|ms|s|%|deg)?/g, 'var(--computed)')
  codeLines.forEach((l, i) => { if (/token-lint-ignore/.test(lines[i])) { if (!/token-lint-ignore:\s*\S/.test(lines[i])) report('ignore-without-reason', file, line0 + i + 1, ['token-lint-ignore']); return }
    const m = l.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix|color)\(/gi); if (m) report('colour', file, line0 + i + 1, m)
    if (!test) { const quoted = (l.match(/(['"`])(?:(?!\1).)*\1/g) ?? []).join(' '), lm = quoted.match(/(?<![\w-])\d*\.?\d+(?:px|rem|em|ex|ch|vw|vh|vmin|vmax|lh|cqi|cqw|pt|cm|mm|in)\b/gi), dm = quoted.match(/(?<![\w-])\d*\.?\d+m?s\b/gi)
      if (lm) report('length', file, line0 + i + 1, lm); if (dm) report('duration', file, line0 + i + 1, dm) } })
  const skip = (i) => /token-lint-ignore/.test(lines[lineAt(i) - 1] ?? '')
  // style="…" / style='…' inside strings and templates
  for (const m of code.matchAll(/\sstyle=(\\?["'])((?:(?!\1).)*)\1/g)) { if (skip(m.index)) continue; lintCss(runtime(m[2]), { file, line0: line0 + lineAt(m.index) - 1, report, tokens, declarationsOnly: true, sourceLines: [lines[lineAt(m.index) - 1]] }) }
  // el.style.cssText = '…'
  for (const m of code.matchAll(/\.style\.cssText\s*\+?=\s*(['"`])((?:(?!\1)[\s\S])*)\1/g)) { if (skip(m.index)) continue; lintCss(runtime(m[2]), { file, line0: line0 + lineAt(m.index) - 1, report, tokens, declarationsOnly: true, sourceLines: [lines[lineAt(m.index) - 1]] }) }
  // el.style.fontWeight = 600 / '600' ; el.style.setProperty('opacity', '.5')
  const kebab = (p) => p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
  for (const m of code.matchAll(/\.style\.([a-zA-Z]+)\s*=\s*(?:(['"`])((?:(?!\2).)*)\2|(-?[\d.]+)\b)(?=\s*(?:[;,)}]|$))/gm)) { if (skip(m.index) || m[1] === 'cssText') continue; const v = m[3] ?? m[4]; lintCss(`${kebab(m[1])}: ${runtime(v)}`, { file, line0: line0 + lineAt(m.index) - 1, report, tokens, declarationsOnly: true, sourceLines: [lines[lineAt(m.index) - 1]] }) }
  for (const m of code.matchAll(/\.style\.setProperty\(\s*(['"])([\w-]+)\1\s*,\s*(?:(['"`])((?:(?!\3).)*)\3|(-?[\d.]+))(?=\s*\))/g)) { if (skip(m.index)) continue; lintCss(`${m[2]}: ${runtime(m[4] ?? m[5])}`, { file, line0: line0 + lineAt(m.index) - 1, report, tokens, declarationsOnly: true, sourceLines: [lines[lineAt(m.index) - 1]] }) }
  const at = (i) => line0 + lineAt(i) - 1, ln = (i) => line0 + lineAt(i), decl = (text, i) => lintCss(runtime(text), { file, line0: at(i), report, tokens, declarationsOnly: true, sourceLines: [lines[lineAt(i) - 1]] })
  // an object of style properties: { opacity: 0.5, color: "tomato", "border-width": "3px" }, read as declarations
  const props = (body, i) => { for (const m of body.matchAll(/(?:^|[,{\s])(['"]?)([a-zA-Z-]+)\1\s*:\s*(?:(['"`])((?:(?!\3).)*)\3|(-?[\d.]+|Infinity)\b)/g)) { const p = kebab(m[2]), v = m[4] ?? m[5]
      if (p === 'iterations' && (v === 'Infinity' || +v > 1)) report('loop', file, ln(i), [`animate(): iterations: ${v}: nothing loops (Motion)`])
      else if (/^(duration|delay|end-delay)$/.test(p) && m[5] && +m[5] !== 0) report('duration', file, ln(i), [`animate(): ${p}: ${v} ms written out: read a duration token`])
      else if (/^(easing)$/.test(p)) { if (v && !/var\(/.test(v)) report('easing', file, ln(i), [`animate(): easing: ${v}`]) }
      else if (!/^(iterations|duration|delay|end-delay|fill|direction|composite|offset|id|pseudo-element|iteration-start|playback-rate|timeline|range-start|range-end)$/.test(p)) decl(`${p}: ${v}`, i) } }
  // Object.assign(el.style, { … })
  for (const m of code.matchAll(/Object\.assign\(\s*[\w$.[\]'"]*\.style\s*,\s*\{([^}]*)\}/g)) { if (!skip(m.index)) props(m[1], m.index) }
  // el.animate(keyframes, options): every property and option written in the call
  for (const m of code.matchAll(/\.animate\(([^;]*?)\)\s*(?:[;\n]|\.)/g)) { if (!skip(m.index)) props(m[1], m.index) }
  // el.setAttribute('style', '…') and a presentation attribute set from script
  for (const m of code.matchAll(/\.setAttribute(?:NS)?\(\s*(?:[^,]+,\s*)?(['"])([\w-]+)\1\s*,\s*(['"`])((?:(?!\3).)*)\3/g)) { if (skip(m.index)) continue
    if (m[2] === 'style') decl(m[4], m.index); else if (m[2] in PRESENTATION) presentation(m[2], runtime(m[4]), (k, w) => report(k, file, ln(m.index), [w]), tokens) }
  // el.style['opacity'] = … (a property by name)
  for (const m of code.matchAll(/\.style\[\s*(['"])([\w-]+)\1\s*\]\s*=\s*(?:(['"`])((?:(?!\3).)*)\3|(-?[\d.]+)\b)/g)) { if (!skip(m.index)) decl(`${kebab(m[2])}: ${m[4] ?? m[5]}`, m.index) }
  // presentation attributes inside markup written as strings: <rect fill="red" stroke-width="3">
  for (const m of code.matchAll(/<[a-zA-Z][^<>]*>/g)) { if (skip(m.index)) continue; for (const a of m[0].matchAll(/\s([a-z-]+)=(\\?["'])((?:(?!\2).)*)\2/g)) if (a[1] in PRESENTATION) presentation(a[1], runtime(a[3]), (k, w) => report(k, file, ln(m.index), [w]), tokens) }
  // matchMedia('(max-width: …)'): a condition, like @media
  for (const m of code.matchAll(/matchMedia\(\s*(['"`])((?:(?!\1).)*)\1/g)) { if (!skip(m.index)) mediaWidths(m[2], breakpoints, (w) => report('breakpoint', file, ln(m.index), [`matchMedia("${m[2]}"): ${w}`])) }
  // an emoji anywhere in code (a string, a template)
  for (const m of code.matchAll(new RegExp(EMOJI.source, 'gu'))) { if (!skip(m.index)) report('emoji', file, ln(m.index), [`${m[0]}: no emoji (Words)`]) }
}

// An SVG presentation attribute (fill="red", stroke-width="3"), read as the property it sets: a colour must be a token (attributes cannot
// read one, so any colour is a literal: use a class), a bare number in a length attribute is px, an opacity other than 1 is an opacity.
function presentation(name, value, r, tokens) {
  const v = value.trim(), kind = PRESENTATION[name]
  if (!v || /^(none|inherit|currentcolor|transparent|url\(#[^)]*\))$/i.test(v) || v.includes('${') || v.includes('var(--computed)')) return
  if (kind === 'length') { if (!/^0([a-z%]*)$/i.test(v)) r('length', `${name}="${v}" (an SVG attribute: a length in px)`); return }
  if (kind === 'opacity') { if (+v !== 1) r('opacity', `${name}="${v}"`); return }
  const hits = []; lintCss(`${name}: ${v}`, { file: '', report: (k, f, l, m) => hits.push([k, m.join(' ')]), tokens, declarationsOnly: true }); for (const [k, m] of hits) r(k, `${name}="${v}" (an SVG attribute) ${m}`)
  if (kind === 'colour' && !hits.length && !/^var\(/.test(v)) r('colour', `${name}="${v}" (an SVG attribute cannot read a token: use a class)`)
}
// the widths in a media condition (a media attribute, matchMedia), against the breakpoint tokens
function mediaWidths(text, breakpoints, r) {
  let ast; try { ast = csstree.parse(text, { context: 'mediaQueryList' }) } catch { r(`"${text}" does not parse`); return }
  csstree.walk(ast, (n) => { if (n.type === 'Dimension') { const u = unesc(n.unit).toLowerCase(), v = +n.value; if (u !== 'px' || (breakpoints && !breakpoints.has(v))) r(`${n.value}${n.unit} is not a breakpoint token (or one less)`) } })
}
// HTML: <style> as CSS, style attributes (any quoting) as CSS, inline scripts as script, colours anywhere else in the text.
export function lintHtml(text, { file, report, tokens, breakpoints }) {
  const doc = parse5.parse(text, { sourceCodeLocationInfo: true }), lines = text.split('\n'), rules = []
  const walk = (n) => {
    if (/^(style|link|source)$/.test(n.nodeName)) for (const a of n.attrs ?? []) if (a.name === 'media') { const at = n.sourceCodeLocation?.attrs?.media?.startLine ?? n.sourceCodeLocation?.startLine ?? 1; mediaWidths(a.value, breakpoints, (what) => report('breakpoint', file, at, [`<${n.nodeName} media="${a.value}">: ${what}`])) }
    if (n.nodeName === 'style') { const t = n.childNodes?.[0]; if (t?.value) { const at = t.sourceCodeLocation?.startLine ?? 1; rules.push(...lintCss(t.value, { file, line0: at - 1, report, tokens, breakpoints, sourceLines: t.value.split('\n') })) } return }
    if (n.nodeName === 'script') { const t = n.childNodes?.[0]; if (t?.value && !(n.attrs ?? []).some((a) => a.name === 'type' && /json/.test(a.value))) lintScript(t.value, { file, line0: (t.sourceCodeLocation?.startLine ?? 1) - 1, report, tokens, breakpoints }); return }
    for (const a of n.attrs ?? []) { const at = n.sourceCodeLocation?.attrs?.[a.name]?.startLine ?? n.sourceCodeLocation?.startLine ?? 1
      if (/token-lint-ignore/.test(lines[at - 1] ?? '')) continue
      if (a.name === 'style') lintCss(a.value, { file, line0: at - 1, report, tokens, declarationsOnly: true, sourceLines: [lines[at - 1]] })
      else if (a.name in PRESENTATION) presentation(a.name, a.value, (kind, what) => report(kind, file, at, [what]), tokens)
      else { const m = a.value.match(/^#[0-9a-f]{3,8}$|\b(?:rgba?|hsla?|oklch|color-mix)\(/i); if (m && !/^(href|id|for|aria-|data-)/.test(a.name)) report('colour', file, at, [`${a.name}="${a.value}"`]) }
      if (EMOJI.test(a.value)) report('emoji', file, at, [`${a.name}="${a.value.slice(0, 40)}": no emoji (Words)`]) }
    if (n.nodeName === '#text') { const m = n.value.match(/\b(?:rgba?|hsla?|oklch|color-mix)\(/gi); if (m) report('colour', file, n.sourceCodeLocation?.startLine ?? 1, m)
      if (EMOJI.test(n.value) && !/^(script|style)$/.test(n.parentNode?.nodeName)) report('emoji', file, n.sourceCodeLocation?.startLine ?? 1, [`"${n.value.trim().slice(0, 40)}": no emoji (Words)`]) }
    n.childNodes?.forEach(walk); if (n.content) walk(n.content)
  }
  walk(doc)
  // The main path of a flow is never a link inside a sentence: in a timeline line the link stands under its sentence (the li's own child),
  // in a banner after it (the banner's own child, or in its row of controls). A link moved into the sentence is text, exempt from the touch
  // height, and so cannot be the main path (v4 review, M3; v5 review, X28).
  const cls = (n) => ((n.attrs ?? []).find((a) => a.name === 'class')?.value ?? '').split(/\s+/)
  const check = (n, inside) => { const c = cls(n)
    if (n.nodeName === 'a' && inside) { const p = n.parentNode, ok = inside === 'timeline' ? p.nodeName === 'li' && cls(p.parentNode).includes('vz-timeline') : cls(p).includes('vz-banner') || cls(p).includes('vz-controls')
      if (!ok) report('main-path', file, n.sourceCodeLocation?.startLine ?? 1, [`a link in a ${inside} is inside <${p.nodeName}${cls(p)[0] ? '.' + cls(p).join('.') : ''}>: it must stand alone, the ${inside === 'timeline' ? "line's own child" : "banner's own child"}`]) }
    // a status's words are one run of text: words with an element in them (a vz-qty, a time) are wrapped in one span, or the element
    // becomes an item of its own beside the mark, off the words' line (Status)
    if (c.includes('vz-status')) { const kids = (n.childNodes ?? []).filter((k) => k.nodeName !== '#comment' && !(k.nodeName === '#text' && !k.value.trim())); if (kids.length > 1 && kids.some((k) => k.nodeName === '#text')) report('status-run', file, n.sourceCodeLocation?.startLine ?? 1, ['a vz-status holds words and an element side by side: wrap its words in one span']) }
    const next = c.includes('vz-timeline') ? 'timeline' : c.includes('vz-banner') ? 'banner' : inside
    n.childNodes?.forEach((k) => check(k, next)) }
  check(doc, null)
  return rules
}
