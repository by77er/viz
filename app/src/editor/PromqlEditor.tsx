import { memo, useEffect, useRef } from 'react'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExt, tooltips } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { bracketMatching, ensureSyntaxTree } from '@codemirror/language'
import { PromQLExtension } from '@prometheus-io/codemirror-promql'
import type { PromClient } from '../api/client'
import { countRender } from '../lib/renders'
import { completionClient } from './promClient'

// The design system's query well does not colour tokens by type: the query is one ink, and
// only an error is marked. Every value below is a design token.
const critical = 'var(--status-critical)'
const underline = (color: string) => ({
  backgroundImage: 'none',
  textDecoration: `underline ${color}`,
  textDecorationThickness: 'var(--stroke)',
  textDecorationSkipInk: 'none',
  textUnderlineOffset: 'var(--space-half)',
})

const theme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'transparent', font: 'var(--text-code)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { padding: '0', caretColor: 'var(--ink)', font: 'var(--text-code)' },
  '.cm-line': { padding: '0' },
  '.cm-scroller': { font: 'var(--text-code)', overflowX: 'auto' },
  '.cm-placeholder': { color: 'var(--ink-muted)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--rule)',
  },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--rule)', color: 'inherit' },
  '.cm-tooltip': {
    border: 'none',
    borderRadius: 'var(--radius-3)',
    backgroundColor: 'var(--raised)',
    color: 'var(--ink)',
    boxShadow: 'var(--shadow-overlay)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { font: 'var(--text-data)', maxHeight: 'calc(var(--row) * 8)', padding: 'var(--space-1)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '0 var(--space-2)', lineHeight: 'var(--row)', borderRadius: 'var(--radius-2)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--hover)', color: 'var(--ink)' },
  '.cm-completionDetail': { color: 'var(--ink-muted)', fontStyle: 'normal', marginLeft: 'var(--space-3)' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: 'var(--text-data-strong-weight)' },
  '.cm-completionInfo': { padding: 'var(--space-1) var(--space-2)', font: 'var(--text-small)', maxWidth: 'calc(var(--overlay-min) * 2)' },
  '.cm-diagnostic': { padding: 'var(--space-1) var(--space-2)', font: 'var(--text-small)', borderLeft: 'none' },
  '.cm-lintRange-error': underline(critical),
  '.cm-lintRange-warning, .cm-lintRange-info, .cm-lintRange-hint': underline('var(--ink-muted)'),
  '.cm-lintPoint:after': { borderBottomColor: critical },
})

export interface PromqlEditorHandle {
  /** Focus the editor; with a position, put the cursor at that character (0-based). */
  focus(at?: number): void
  /** The text in the editor now. */
  getValue(): string
  /**
   * Where the editor's PromQL parser finds the first syntax error (0-based), when the text in
   * the editor is still `query`; null when it finds none, or the text has changed since.
   */
  syntaxErrorAt(query: string): number | null
}

/** The first error node of the parse tree, or null. */
export function firstSyntaxError(state: EditorState): number | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 200)
  if (!tree) return null
  let at: number | null = null
  tree.iterate({
    enter: (node) => {
      if (at !== null) return false
      if (node.type.isError) {
        at = node.from
        return false
      }
      return undefined
    },
  })
  return at
}

interface Props {
  /**
   * The committed query (the URL's). The editor owns the text being typed: this prop only
   * replaces the document when it changes from outside (navigation, an example link).
   */
  value: string
  /** Ctrl/Cmd+Enter. */
  onRun: () => void
  client: PromClient
  handleRef?: React.RefObject<PromqlEditorHandle | null>
  /** The page's query window (epoch seconds), read by autocomplete at each lookup. */
  rangeRef?: React.RefObject<{ start: number; end: number } | null>
  /** Called once, when the editor and its handle exist (it is a lazily loaded chunk). */
  onReady?: () => void
}

/**
 * The editor keeps its own text. Nothing outside it is told about a keystroke: the page
 * reads the text when the query is run (`handleRef.current.getValue()`), so typing renders
 * nothing in React (design review B3). The extensions are built once per editor, and the
 * autocomplete source once per connection.
 */
export default memo(function PromqlEditor({ value, onRun, client, handleRef, rangeRef, onReady }: Props) {
  countRender('PromqlEditor')
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langCompartment = useRef(new Compartment())
  const cb = useRef({ onRun })
  cb.current = { onRun }

  const promqlExtension = (c: PromClient) =>
    new PromQLExtension().setComplete({ remote: completionClient(c, { range: () => rangeRef?.current ?? null }), maxMetricsMetadata: 10000 }).asExtension()

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          closeBrackets(),
          bracketMatching(),
          // The list shows eight rows; it is rebuilt on every keystroke while it is open, so it
          // renders five screens of options rather than ten (design review B3). Arrow keys move
          // the rendered window, so every option stays reachable.
          autocompletion({ icons: false, maxRenderedOptions: 40 }),
          theme,
          tooltips({ position: 'absolute' }),
          placeholderExt('rate(http_requests_total[5m])'),
          // tabindex: the well scrolls sideways, and a scrolling region must hold something focusable.
          EditorView.contentAttributes.of({ 'aria-label': 'PromQL query', 'aria-multiline': 'true', spellcheck: 'false', tabindex: '0' }),
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Enter',
                run: () => {
                  cb.current.onRun()
                  return true
                },
              },
            ]),
          ),
          keymap.of([...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, ...defaultKeymap]),
          langCompartment.current.of(promqlExtension(client)),
        ],
      }),
    })
    viewRef.current = view
    if (handleRef)
      handleRef.current = {
        focus: (at) => {
          view.focus()
          if (at !== undefined) {
            const anchor = Math.max(0, Math.min(view.state.doc.length, at))
            view.dispatch({ selection: { anchor }, scrollIntoView: true })
          }
        },
        getValue: () => view.state.doc.toString(),
        syntaxErrorAt: (query) => (view.state.doc.toString().trim() === query.trim() ? firstSyntaxError(view.state) : null),
      }
    onReady?.()
    return () => {
      view.destroy()
      viewRef.current = null
      if (handleRef) handleRef.current = null
    }
    // Created once; value and client are synchronised by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // External value changes (URL navigation, example queries).
  useEffect(() => {
    const view = viewRef.current
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  }, [value])

  // New connection settings -> new autocomplete source.
  const firstClient = useRef(client)
  useEffect(() => {
    if (firstClient.current === client) return
    firstClient.current = client
    viewRef.current?.dispatch({ effects: langCompartment.current.reconfigure(promqlExtension(client)) })
  }, [client])

  return <div ref={hostRef} data-testid="query-editor" />
})
