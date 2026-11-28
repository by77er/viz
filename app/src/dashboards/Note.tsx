import type { ReactNode } from 'react'

/**
 * A text note's Markdown as text a person reads (D-M1 of the third design review): headings as
 * headings, paragraphs and lists as the system's prose, strong emphasis as weight. Only the
 * Markdown a note uses is read: `#` headings, paragraphs, `-`/`*`/`1.` lists, `**strong**`,
 * `*emphasis*` (shown as plain text: the system has no italics), `` `code` `` (mono) and
 * `[text](https://…)` links. Nothing is ever written as HTML: every part is a React text node.
 */
export interface NoteBlock {
  kind: 'heading' | 'paragraph' | 'list'
  /** A list's items, or the one line of a heading or paragraph. */
  lines: string[]
  ordered?: boolean
}

/** The note's blocks, in order. Pure. */
export function noteBlocks(md: string): NoteBlock[] {
  const out: NoteBlock[] = []
  let para: string[] = []
  let list: NoteBlock | null = null
  const flush = () => {
    if (para.length) out.push({ kind: 'paragraph', lines: [para.join(' ')] })
    para = []
    if (list) out.push(list)
    list = null
  }
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line === '') {
      flush()
      continue
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      flush()
      out.push({ kind: 'heading', lines: [h[1]!.replace(/\s+#+\s*$/, '')] })
      continue
    }
    const item = /^(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (item) {
      if (para.length) {
        out.push({ kind: 'paragraph', lines: [para.join(' ')] })
        para = []
      }
      const ordered = item[2] !== undefined
      if (!list || list.ordered !== ordered) {
        if (list) out.push(list)
        list = { kind: 'list', lines: [], ordered }
      }
      list.lines.push(item[3]!)
      continue
    }
    if (list) {
      // A line under an item continues it.
      list.lines[list.lines.length - 1] += ` ${line}`
      continue
    }
    para.push(line)
  }
  flush()
  return out
}

/** A note as plain sentences (the text forms): the Markdown's marks dropped. */
export function notePlain(md: string): string[] {
  return noteBlocks(md).flatMap((b) => b.lines.map((l) => inlineParts(l).map((p) => p.text).join('')))
}

interface Part {
  text: string
  strong?: boolean
  code?: boolean
  href?: string
}

/** A line's inline parts. `*emphasis*` keeps its words and loses its marks. */
function inlineParts(line: string): Part[] {
  const out: Part[] = []
  const re = /\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*|_([^_]+)_/g
  let at = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) })
    if (m[1] !== undefined || m[2] !== undefined) out.push({ text: (m[1] ?? m[2])!, strong: true })
    else if (m[3] !== undefined) out.push({ text: m[3], code: true })
    else if (m[4] !== undefined) out.push(/^https?:\/\//.test(m[5]!) ? { text: m[4], href: m[5]! } : { text: m[4] })
    else out.push({ text: (m[6] ?? m[7])! })
    at = m.index + m[0].length
  }
  if (at < line.length) out.push({ text: line.slice(at) })
  return out
}

function Inline({ line }: { line: string }) {
  return (
    <>
      {inlineParts(line).map((p, i) =>
        p.strong ? (
          <b key={i}>{p.text}</b>
        ) : p.code ? (
          <code key={i} className="vz-qty">
            {p.text}
          </code>
        ) : p.href ? (
          <a key={i} className="vz-link" href={p.href} rel="noreferrer noopener" target="_blank">
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

/** The note as the system's prose. `level` is the heading level of the panel's own title, so the note's headings sit under it. */
export function Note({ markdown, level, lead }: { markdown: string; level: 2 | 3; lead?: ReactNode }) {
  const blocks = noteBlocks(markdown)
  const H = level === 2 ? 'h3' : 'h4'
  return (
    <div className="vz-stack note" data-testid="panel-note">
      {lead}
      {blocks.map((b, i) =>
        b.kind === 'heading' ? (
          <H key={i}>
            <Inline line={b.lines[0]!} />
          </H>
        ) : b.kind === 'list' ? (
          b.ordered ? (
            <ol key={i} className="vz-text">
              {b.lines.map((l, j) => (
                <li key={j}>
                  <Inline line={l} />
                </li>
              ))}
            </ol>
          ) : (
            <ul key={i} className="vz-text">
              {b.lines.map((l, j) => (
                <li key={j}>
                  <Inline line={l} />
                </li>
              ))}
            </ul>
          )
        ) : (
          <p key={i} className="vz-text">
            <Inline line={b.lines[0]!} />
          </p>
        ),
      )}
    </div>
  )
}
