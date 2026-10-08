import type { HashlineSnapshot } from '../types'

/** Separates an anchor from its line in every row the tools serve. */
export const SEP = '│'

/** Private-use glyphs (powerline, most nerd font icons): stripped from tool text in both directions. */
const OPAQUE = /[\uE000-\uF8FF]/g
const TOKEN = /⟦U\+([0-9A-Fa-f]{4,6})⟧/g

/**
 * The `⟦U+XXXX⟧` token that decodeGlyphs turns into `code`.
 *
 * @example decodeGlyphs(tokenFor(0x5c)) // "\\"
 */
export function tokenFor(code: number): string {
  return `⟦U+${code.toString(16).toUpperCase().padStart(4, '0')}⟧`
}

/**
 * Shows each private-use glyph in U+E000..U+F8FF as a `⟦U+XXXX⟧` token, since
 * those code points cannot reach the model or come back from it.
 *
 * @example encodeGlyphs('a\uE0B0b') // "a⟦U+E0B0⟧b"
 */
export function encodeGlyphs(line: string): string {
  return line.replace(OPAQUE, glyph => tokenFor(glyph.charCodeAt(0)))
}

/**
 * Turns each `⟦U+XXXX⟧` token into its code point, the inverse of
 * encodeGlyphs. Tokens for NUL, surrogates or past U+10FFFF stay as typed.
 *
 * @example decodeGlyphs('a⟦U+E0B0⟧b') // "a\uE0B0b"
 */
export function decodeGlyphs(text: string): string {
  return text.replace(TOKEN, (token, hex: string) => {
    const code = parseInt(hex, 16)
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
    return valid ? String.fromCodePoint(code) : token
  })
}

/** True when `text` holds a `⟦U+XXXX⟧` token as literal characters. */
export function hasToken(text: string): boolean {
  return /⟦U\+[0-9A-Fa-f]{4,6}⟧/.test(text)
}

/** Rows a single read serves before it asks for an offset. */
export const MAX_ROWS = 2000
/** Bytes a single read serves before it asks for an offset. */
export const MAX_BYTES = 50 * 1024
/** Characters of one line shown before the row is cut. */
export const MAX_LINE = 2000
/** Above this many cells, realignment skips the LCS and mints fresh anchors. */
const LCS_BUDGET = 4_000_000

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const HEADS = [...LETTERS].flatMap(a => [...LETTERS].map(b => a.toUpperCase() + b))
const TAILS = [...LETTERS].flatMap(a => [...LETTERS].map(b => a + b))
/** How many distinct anchors exist before they repeat. */
export const ANCHOR_SPACE = HEADS.length * TAILS.length
/** Coprime with ANCHOR_SPACE (2^4 * 13^4), so consecutive anchors look unrelated. */
const STRIDE = 104_729

/**
 * The anchor minted for the `n`th allocation of a session: four letters, a
 * capitalised pair then a lower-case pair.
 *
 * @example anchorFor(0) // "Alsp"
 */
export function anchorFor(n: number): string {
  const slot = (((n * STRIDE + 7_919) % ANCHOR_SPACE) + ANCHOR_SPACE) % ANCHOR_SPACE
  return HEADS[Math.floor(slot / TAILS.length)]! + TAILS[slot % TAILS.length]!
}

/**
 * The anchors of allocations `from`..`from+count-1` that are not in `taken`,
 * each added to `taken` as it is minted, so a file never holds one anchor
 * twice once the counter wraps past ANCHOR_SPACE.
 *
 * @example mint(0, 2, new Set([anchorFor(0)])) // [anchorFor(1)]
 */
export function mint(from: number, count: number, taken: Set<string>): string[] {
  const out: string[] = []
  for (let n = from; n < from + count; n++) {
    const anchor = anchorFor(n)
    if (taken.has(anchor)) continue
    taken.add(anchor)
    out.push(anchor)
  }
  return out
}

/** True when `text` has the shape of an anchor. */
export function isAnchor(text: string): boolean {
  return /^[A-Z][a-z]{3}$/.test(text)
}

/**
 * Accepts what a model pastes for an anchor: the bare anchor, or a whole
 * served row (`Dafo│code`, `+Dafo│code`, `12│Dafo│code`).
 */
export function cleanAnchor(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const parts = raw.trim().replace(/^[+ ]/, '').split(SEP)
  const found = parts.find(part => isAnchor(part.trim()))
  return found?.trim()
}

/** FNV-1a over the whole line as canonicalised: no `\r`, no trailing whitespace. */
export function hashLine(line: string): number {
  return fnv(line.replace(/\r/g, '').trimEnd())
}

/** FNV-1a over every UTF-16 unit of `text`. */
export function fnv(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** A line break as a file spells it. */
export type Eol = '\n' | '\r\n'

/**
 * A file's text split into lines, with what it takes to write it back
 * unchanged: `ends` holds each line's own break (the last line's is the one it
 * gets if lines are added after it) and `eol` the break most lines use.
 */
export type Parsed = { lines: string[]; ends: Eol[]; eol: Eol; hasFinalEol: boolean }

export function parse(text: string): Parsed {
  if (text === '') return { lines: [], ends: [], eol: '\n', hasFinalEol: false }
  const parts = text.split('\n')
  const hasFinalEol = parts[parts.length - 1] === ''
  if (hasFinalEol) parts.pop()
  const breaks = hasFinalEol ? parts.length : parts.length - 1
  const lines: string[] = []
  const ends: Eol[] = []
  let crlf = 0
  parts.forEach((part, i) => {
    const isCrlf = i < breaks && part.endsWith('\r')
    if (isCrlf) crlf++
    lines.push(isCrlf ? part.slice(0, -1) : part)
    ends.push(isCrlf ? '\r\n' : '\n')
  })
  const eol: Eol = crlf * 2 > breaks ? '\r\n' : '\n'
  if (!hasFinalEol) ends[ends.length - 1] = eol
  return { lines, ends, eol, hasFinalEol }
}

export function serialize({ lines, ends, hasFinalEol }: Parsed): string {
  let out = ''
  lines.forEach((line, i) => {
    out += line
    if (i < lines.length - 1 || hasFinalEol) out += ends[i]!
  })
  return out
}

/**
 * `parsed` with `count` lines from `start` replaced by `added`. Added lines
 * take the break of the line they replace or follow, so a file with mixed
 * breaks keeps every other line's as it was. An empty file gains a final break.
 */
export function splice(parsed: Parsed, start: number, count: number, added: string[]): Parsed {
  const { lines, ends, eol, hasFinalEol } = parsed
  const end = ends[start] ?? ends[start - 1] ?? eol
  return {
    lines: [...lines.slice(0, start), ...added, ...lines.slice(start + count)],
    ends: [...ends.slice(0, start), ...added.map(() => end), ...ends.slice(start + count)],
    eol,
    hasFinalEol: lines.length === 0 || hasFinalEol,
  }
}

/**
 * Splits the `text` argument of an edit into lines: `""` is no lines, and
 * one trailing newline is dropped so `"a\n"` is the single line `a`.
 */
export function textLines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\r?\n$/, '').split(/\r?\n/)
}

/**
 * Carries anchors from `prev` onto lines with `hashes`, keeping each anchor
 * whose line survived unchanged; `undefined` marks a line that needs a fresh one.
 */
export function align(prev: HashlineSnapshot | undefined, hashes: number[]): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(hashes.length).fill(undefined)
  if (!prev) return out
  const old = prev.hashes
  let head = 0
  while (head < old.length && head < hashes.length && old[head] === hashes[head]) {
    out[head] = prev.anchors[head]
    head++
  }
  let tail = 0
  while (
    tail < old.length - head &&
    tail < hashes.length - head &&
    old[old.length - 1 - tail] === hashes[hashes.length - 1 - tail]
  ) {
    out[hashes.length - 1 - tail] = prev.anchors[old.length - 1 - tail]
    tail++
  }
  const m = old.length - head - tail
  const n = hashes.length - head - tail
  if (m === 0 || n === 0 || m * n > LCS_BUDGET) return out
  const width = n + 1
  const table = new Int32Array((m + 1) * width)
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i * width + j] =
        old[head + i] === hashes[head + j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (old[head + i] === hashes[head + j]) {
      out[head + j] = prev.anchors[head + i]
      i++
      j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return out
}

/** Fills each `undefined` slot from `fresh`, in order. */
export function fill(slots: (string | undefined)[], fresh: string[]): string[] {
  let k = 0
  return slots.map(slot => slot ?? fresh[k++]!)
}

/** True when the row served for `line` is cut at MAX_LINE, so the model never saw all of it. */
export function isCut(line: string): boolean {
  return encodeGlyphs(line).length > MAX_LINE
}

/** One served row: the anchor, the separator, the line with glyphs encoded (cut past MAX_LINE). */
export function row(anchor: string, line: string): string {
  const encoded = encodeGlyphs(line)
  const shown =
    encoded.length > MAX_LINE
      ? `${encoded.slice(0, MAX_LINE)}… [${encoded.length - MAX_LINE} more chars]`
      : encoded
  return anchor + SEP + shown
}

/** Rows `from`..`to` (0-based, inclusive, clamped) of a file. */
export function rows(lines: string[], anchors: string[], from: number, to: number): string[] {
  const out: string[] = []
  for (let i = Math.max(0, from); i <= Math.min(lines.length - 1, to); i++) {
    out.push(row(anchors[i]!, lines[i]!))
  }
  return out
}

/** What an edit replaced: lines `start`..`start+removed-1` became `added` new ones. */
export type Change = { start: number; removed: string[]; added: number }

/**
 * One row of a line diff, with its 0-based line in the old file (`before`)
 * and the new one (`after`). A `-` row's `after`, and a `+` row's `before`,
 * is the line that follows where it would sit. `text` is the line itself.
 */
export type Op = { kind: ' ' | '-' | '+'; before: number; after: number; text: string }

/**
 * The rows turning `removed` (old lines from `start`, with their anchors)
 * into `added`. An added line is unchanged when align carried its old anchor
 * over in `slots` and its text is equal, so a trailing-whitespace edit still
 * shows as a change.
 */
export function diffOps(
  start: number,
  removed: string[],
  removedAnchors: string[],
  added: string[],
  slots: (string | undefined)[],
): Op[] {
  const at = new Map(removedAnchors.map((anchor, i) => [anchor, i]))
  const pairs: [number, number][] = []
  let floor = 0
  slots.forEach((slot, j) => {
    const i = slot === undefined ? undefined : at.get(slot)
    if (i === undefined || i < floor || removed[i] !== added[j]) return
    pairs.push([i, j])
    floor = i + 1
  })
  pairs.push([removed.length, added.length])
  const ops: Op[] = []
  let i = 0
  let j = 0
  for (const [keptI, keptJ] of pairs) {
    for (; i < keptI; i++) ops.push({ kind: '-', before: start + i, after: start + j, text: removed[i]! })
    for (; j < keptJ; j++) ops.push({ kind: '+', before: start + i, after: start + j, text: added[j]! })
    if (i < removed.length) {
      ops.push({ kind: ' ', before: start + i, after: start + j, text: added[j]! })
      i++
      j++
    }
  }
  return ops
}

/**
 * Splits `ops` into hunks, each change with up to `context` unchanged lines
 * either side; lines outside `ops` are read from the new file's `lines`.
 */
export function hunks(ops: Op[], lines: string[], context: number): Op[][] {
  if (ops.length === 0) return []
  const first = ops[0]!
  const last = ops[ops.length - 1]!
  const all: Op[] = []
  for (let d = Math.min(context, first.before, first.after); d > 0; d--) {
    all.push({ kind: ' ', before: first.before - d, after: first.after - d, text: lines[first.after - d]! })
  }
  all.push(...ops)
  const nextBefore = last.kind === '+' ? last.before : last.before + 1
  const nextAfter = last.kind === '-' ? last.after : last.after + 1
  for (let d = 0; d < context && nextAfter + d < lines.length; d++) {
    all.push({ kind: ' ', before: nextBefore + d, after: nextAfter + d, text: lines[nextAfter + d]! })
  }
  const near = new Array<boolean>(all.length).fill(false)
  all.forEach((op, k) => {
    if (op.kind === ' ') return
    for (let n = Math.max(0, k - context); n <= Math.min(all.length - 1, k + context); n++) near[n] = true
  })
  const out: Op[][] = []
  let current: Op[] = []
  all.forEach((op, k) => {
    if (near[k]) {
      current.push(op)
    } else if (current.length > 0) {
      out.push(current)
      current = []
    }
  })
  if (current.length > 0) out.push(current)
  return out
}

/**
 * The diff an edit result shows the model: ` A│x` for an unchanged line, `-x`
 * for a removed one, `+A│x` for an added one with its anchor, and `…` between
 * hunks. `anchors` are the new file's.
 */
export function renderDiff(groups: Op[][], anchors: string[], cap = 200): string {
  const out: string[] = []
  groups.forEach((group, k) => {
    if (k > 0) out.push('…')
    for (const op of group) {
      out.push(op.kind === '-' ? '-' + encodeGlyphs(op.text) : op.kind + row(anchors[op.after]!, op.text))
    }
  })
  if (out.length <= cap) return out.join('\n')
  return [...out.slice(0, cap), `… ${out.length - cap} more diff rows; read the file for the rest`].join('\n')
}

/** Characters of one line a unified diff shows before it cuts the rest. */
const DIFF_LINE = 500
/** What stands in a removed row's anchor column: blanks as wide as an anchor. */
const NO_ANCHOR = ' '.repeat(4)
/** Room kept for a hunk header while its rows are counted against the budget. */
const HEADER_ROOM = 48
/** What Code refuses in its source: every control character but tab and newline. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
const REPLACEMENT = String.fromCharCode(0xfffd)

function hunkHeader(ops: Op[]): string {
  const old = ops.filter(op => op.kind !== '+')
  const now = ops.filter(op => op.kind !== '-')
  const oldStart = old.length > 0 ? old[0]!.before + 1 : ops[0]!.before
  const newStart = now.length > 0 ? now[0]!.after + 1 : ops[0]!.after
  return `@@ -${oldStart},${old.length} +${newStart},${now.length} @@`
}

/**
 * `groups` as unified-diff hunks with 1-based line numbers, at most `budget`
 * characters. A hunk that does not fit is cut at a row and its header counts
 * only the rows kept, so the text still parses; later hunks are dropped.
 *
 * Each row's text leads with its anchor in the new file (`anchors`) and the
 * separator, as the model's rows do; a removed row, whose anchor is gone,
 * leads with blanks so the columns line up.
 *
 * @example unifiedDiff(groups, anchors) // "@@ -1,2 +1,2 @@\n Alsp│one\n-    │two\n+Qbxe│TWO"
 */
export function unifiedDiff(groups: Op[][], anchors: readonly string[], budget = 10_000): string {
  const out: string[] = []
  let used = 0
  for (const group of groups) {
    const shown: Op[] = []
    const body: string[] = []
    for (const op of group) {
      const text = op.text.length > DIFF_LINE ? `${op.text.slice(0, DIFF_LINE)}…` : op.text
      const anchor = op.kind === '-' ? NO_ANCHOR : anchors[op.after]!
      const line = op.kind + anchor + SEP + text.replace(CONTROL, REPLACEMENT)
      if (used + HEADER_ROOM + line.length + 1 > budget) break
      shown.push(op)
      body.push(line)
      used += line.length + 1
    }
    if (shown.length === 0) break
    const header = hunkHeader(shown)
    out.push(header, ...body)
    used += header.length + 1
    if (shown.length < group.length) break
  }
  return out.join('\n')
}
