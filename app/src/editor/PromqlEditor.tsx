import { useEffect, useRef } from 'react'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExt, tooltips } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { PromQLExtension } from '@prometheus-io/codemirror-promql'
import type { PromClient } from '../api/client'
import { completionClient } from './promClient'

// Colours come from CSS variables, so one highlight style serves both themes.
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: 'var(--tok-keyword)' },
  { tag: [tags.function(tags.variableName), tags.standard(tags.variableName)], color: 'var(--tok-function)' },
  { tag: tags.string, color: 'var(--tok-string)' },
  { tag: [tags.number, tags.bool], color: 'var(--tok-number)' },
  { tag: [tags.labelName, tags.propertyName], color: 'var(--tok-label)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--tok-operator)' },
  { tag: tags.comment, color: 'var(--fg-3)', fontStyle: 'italic' },
  { tag: tags.invalid, color: 'var(--danger)' },
])

const theme = EditorView.theme({
  '&': { color: 'var(--fg)' },
  '.cm-content': { padding: '7px 0', caretColor: 'var(--fg)', minHeight: '32px' },
  '.cm-line': { padding: '0 10px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '18px', overflowX: 'auto' },
  '.cm-placeholder': { color: 'var(--fg-3)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--focus) 28%, transparent)',
  },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--surface-3)', outline: '1px solid var(--line-strong)' },
  '.cm-tooltip': {
    border: 'none',
    borderRadius: '6px',
    backgroundColor: 'var(--surface)',
    color: 'var(--fg)',
    boxShadow: 'var(--shadow)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px', maxHeight: '260px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', lineHeight: '18px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--fg)' },
  '.cm-completionDetail': { color: 'var(--fg-3)', fontStyle: 'normal', marginLeft: '12px' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
  '.cm-completionIcon': { opacity: '0.7', width: '1.1em' },
  '.cm-completionInfo': { padding: '6px 8px', fontFamily: 'var(--font-sans)', fontSize: '12px', maxWidth: '320px' },
  '.cm-diagnostic': { padding: '4px 8px', fontFamily: 'var(--font-sans)', fontSize: '12px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--danger)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
})

export interface PromqlEditorHandle {
  focus(): void
}

interface Props {
  value: string
  onChange: (value: string) => void
  /** Ctrl/Cmd+Enter. */
  onRun: () => void
  client: PromClient
  handleRef?: React.RefObject<PromqlEditorHandle | null>
}

export default function PromqlEditor({ value, onChange, onRun, client, handleRef }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langCompartment = useRef(new Compartment())
  const cb = useRef({ onChange, onRun })
  cb.current = { onChange, onRun }

  const promqlExtension = (c: PromClient) =>
    new PromQLExtension().setComplete({ remote: completionClient(c), maxMetricsMetadata: 10000 }).asExtension()

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          closeBrackets(),
          bracketMatching(),
          autocompletion({ icons: true, maxRenderedOptions: 80 }),
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          tooltips({ position: 'absolute' }),
          placeholderExt('Enter a PromQL query, e.g. sum by (service) (rate(http_requests_total[5m]))'),
          EditorView.contentAttributes.of({ 'aria-label': 'PromQL query', 'aria-multiline': 'true', spellcheck: 'false' }),
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
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    if (handleRef) handleRef.current = { focus: () => view.focus() }
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

  return <div ref={hostRef} className="min-w-0 flex-1" data-testid="query-editor" />
}
