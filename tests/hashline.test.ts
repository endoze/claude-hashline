import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  ANCHOR_SPACE,
  align,
  anchorFor,
  cleanAnchor,
  decodeGlyphs,
  encodeGlyphs,
  hashLine,
  isCut,
  mint,
  parse,
  serialize,
  splice,
  unifiedDiff,
} from '../hooks/hashline'

const POWERLINE = String.fromCharCode(0xe0b0)
const GITHUB = String.fromCharCode(0xf113)
const token = (hex: string) => `⟦U+${hex}⟧`

type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string }
type Decide = (tool: string, input: { file_path?: string; path?: string }) => Verdict

const allowAll: Decide = () => ({ decision: 'allow' })

/**
 * What the engine answers beneath a hashline tool's `tool.call` hook once its
 * permission flow has run: the 2.1.295 failure for a registered tool no hook
 * served, which hashline reads as allowed.
 */
function unanswered(tool: string) {
  const name = tool.replace('mcp__hashline__', '')
  const text = `hashline registered the tool ${name} but no tool.call hook answered this call: add on("tool.call", { tool: "${tool}" }, ($, e) => ({ result: ... })) to the plugin.`
  return { result: `Error: ${text}`, text, isError: true }
}

function disk(on: On, files: Record<string, string>, decide: Decide = allowAll, flow: (tool: string) => object = unanswered) {
  on('fs.stat', ($, e) => {
    const text = files[e.path]
    if (text === undefined) return { deny: 'ENOENT' }
    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false, realPath: e.path } }
  })
  on('fs.read', ($, e) => {
    const text = files[e.path]
    if (text === undefined) return { deny: 'ENOENT' }
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('tool.check', ($, e) => decide(e.tool, e.input as { file_path?: string; path?: string }))
  on('tool.call', { tool: /^mcp__hashline__/ }, ($, e) => flow(e.tool) as never)
}

function anchorsOf(text: string): string[] {
  return [...text.matchAll(/^[+ ]?([A-Z][a-z]{3})│/gm)].map(m => m[1]!)
}

async function call($: { tool: { call: (input: never) => Promise<unknown> } }, input: Record<string, unknown>) {
  const ran = (await $.tool.call(input as never)) as { result?: unknown; deny?: string; text?: string }
  return String(ran.deny ?? ran.result ?? ran.text)
}

describe('core', () => {
  test('anchors are four letters and distinct', () => {
    const seen = new Set(Array.from({ length: 5000 }, (_, n) => anchorFor(n)))
    expect(seen.size).toBe(5000)
    expect(anchorFor(0)).toBe('Alsp')
  })

  test('mint skips anchors a file already holds, past the wrap too', () => {
    expect(mint(0, 3, new Set([anchorFor(1)]))).toEqual([anchorFor(0), anchorFor(2)])
    expect(anchorFor(ANCHOR_SPACE)).toBe(anchorFor(0))
    expect(mint(ANCHOR_SPACE, 2, new Set([anchorFor(0)]))).toEqual([anchorFor(1)])
  })

  test('parse and serialize round-trip line endings', () => {
    for (const text of ['', 'a', 'a\n', 'a\r\nb\r\n', '\n\n', 'a\nb\r\nc\n', 'a\r\nb', 'a\r', '\r\n']) {
      expect(serialize(parse(text))).toBe(text)
    }
  })

  test('splice keeps each line its own break', () => {
    const mixed = parse('a\nb\r\nc\n')
    expect(serialize(splice(mixed, 2, 1, ['C', 'D']))).toBe('a\nb\r\nC\nD\n')
    expect(serialize(splice(parse('a\nb\nc\r\nd\r\ne\r\n'), 1, 1, ['B']))).toBe('a\nB\nc\r\nd\r\ne\r\n')
    expect(serialize(splice(parse('a\r\nb'), 2, 0, ['c']))).toBe('a\r\nb\r\nc')
    expect(serialize(splice(parse(''), 0, 0, ['x']))).toBe('x\n')
  })

  test('parse takes the break most lines use', () => {
    expect(parse('a\r\nb\r\nc\n').eol).toBe('\r\n')
    expect(parse('a\nb\nc\r\n').eol).toBe('\n')
  })

  test('hashLine reads the whole line but not its trailing whitespace', () => {
    const long = 'x'.repeat(600)
    expect(hashLine(`${long}a`) === hashLine(`${long}b`)).toBe(false)
    expect(hashLine('a  ')).toBe(hashLine('a'))
  })

  test('isCut marks lines read serves cut', () => {
    expect(isCut('x'.repeat(2000))).toBe(false)
    expect(isCut('x'.repeat(2001))).toBe(true)
  })

  test('align keeps anchors of unchanged lines around a change', () => {
    const prev = { anchors: ['Aaaa', 'Bbbb', 'Cccc', 'Dddd'], hashes: [1, 2, 3, 4] }
    expect(align(prev, [1, 9, 3, 4])).toEqual(['Aaaa', undefined, 'Cccc', 'Dddd'])
    expect(align(prev, [1, 3, 7, 4])).toEqual(['Aaaa', 'Cccc', undefined, 'Dddd'])
  })

  test('cleanAnchor accepts pasted rows', () => {
    expect(cleanAnchor('Dafo│function hello() {')).toBe('Dafo')
    expect(cleanAnchor('+Dafo│x')).toBe('Dafo')
    expect(cleanAnchor('nope')).toBe(undefined)
  })

  test('glyph tokens stand in for private-use code points only', () => {
    const line = `a${POWERLINE}b 日本 ⟦U+0⟧`
    expect(encodeGlyphs(line)).toBe(`a${token('E0B0')}b 日本 ⟦U+0⟧`)
    expect(decodeGlyphs(encodeGlyphs(line))).toBe(line)
    expect(decodeGlyphs(token('F0001'))).toBe(String.fromCodePoint(0xf0001))
    expect(decodeGlyphs('⟦U+0000⟧ ⟦U+D800⟧ ⟦U+110000⟧')).toBe('⟦U+0000⟧ ⟦U+D800⟧ ⟦U+110000⟧')
  })

  test('a unified diff cut to its budget still counts its rows', () => {
    const ops = Array.from({ length: 50 }, (_, k) => ({ kind: '+' as const, before: 0, after: k, text: `line ${k}` }))
    const anchors = Array.from({ length: 50 }, (_, k) => anchorFor(k))
    const source = unifiedDiff([ops, ops], anchors, 200)
    const [header, ...body] = source.split('\n')
    expect(source.length <= 200).toBe(true)
    expect(header).toBe(`@@ -0,0 +1,${body.length} @@`)
  })
})

describe('tools', () => {
  test('read serves anchored rows and replace edits by anchor', async ($, on) => {
    const files: Record<string, string> = { '/a.ts': 'one\ntwo\nthree\n' }
    disk(on, files)

    const read = await call($, { tool: 'mcp__hashline__read', path: '/a.ts' })
    const [a1, a2, a3] = anchorsOf(read.split('\n').slice(1).join('\n'))
    expect(read).toContain(`${a2}│two`)

    const edited = await call($, { tool: 'mcp__hashline__replace', path: '/a.ts', remove_from: a2, remove_to: a2, text: 'TWO\n2b' })
    expect(files['/a.ts']).toBe('one\nTWO\n2b\nthree\n')
    expect(edited).toContain(`-two`)

    const again = await call($, { tool: 'mcp__hashline__read', path: '/a.ts' })
    expect(again).toContain(`${a1}│one`)
    expect(again).toContain(`${a3}│three`)
    expect(again).not.toContain(`${a2}│`)
  })

  test('a stale anchor is refused after the line changes on disk', async ($, on) => {
    const files: Record<string, string> = { '/b.ts': 'x\ny\n' }
    disk(on, files)
    const read = await call($, { tool: 'mcp__hashline__read', path: '/b.ts' })
    const [, ay] = anchorsOf(read)
    files['/b.ts'] = 'x\nchanged\n'
    const out = await call($, { tool: 'mcp__hashline__replace', path: '/b.ts', remove_from: ay, remove_to: ay, text: 'z' })
    expect(out).toContain('[E_RANGE_STALE]')
    expect(files['/b.ts']).toBe('x\nchanged\n')
  })

  test('a change on disk past column 500 still makes the anchor stale', async ($, on) => {
    const long = 'x'.repeat(600)
    const files: Record<string, string> = { '/long.txt': `${long}tail\n` }
    disk(on, files)
    const [line] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/long.txt' }))
    files['/long.txt'] = `${long}TAIL\n`
    const out = await call($, { tool: 'mcp__hashline__replace', path: '/long.txt', remove_from: line, remove_to: line, text: 'short' })
    expect(out).toContain('[E_RANGE_STALE]')
    expect(files['/long.txt']).toBe(`${long}TAIL\n`)
  })

  test('replace refuses a line read served cut, and replace_match edits it', async ($, on) => {
    const files: Record<string, string> = { '/cut.txt': `${'y'.repeat(2500)}\n` }
    disk(on, files)
    const read = await call($, { tool: 'mcp__hashline__read', path: '/cut.txt' })
    expect(read).toContain('… [500 more chars]')
    const [line] = anchorsOf(read)
    const refused = await call($, { tool: 'mcp__hashline__replace', path: '/cut.txt', remove_from: line, remove_to: line, text: 'yyy' })
    expect(refused).toContain('[E_LONG_LINE]')
    expect(files['/cut.txt']).toBe(`${'y'.repeat(2500)}\n`)
    await call($, { tool: 'mcp__hashline__replace_match', path: '/cut.txt', replace_from: line, replace_to: line, old_string: 'y'.repeat(2500), new_string: 'short' })
    expect(files['/cut.txt']).toBe('short\n')
  })

  test('replace_match, insert and undo', async ($, on) => {
    const files: Record<string, string> = { '/c.ts': 'const a = 1\nconst b = 1\n' }
    disk(on, files)
    const [aa, ab] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/c.ts' }))

    const diff = await call($, { tool: 'mcp__hashline__replace_match', path: '/c.ts', replace_from: aa, replace_to: ab, old_string: '1', new_string: '2' })
    expect(files['/c.ts']).toBe('const a = 2\nconst b = 2\n')

    const stale = await call($, { tool: 'mcp__hashline__replace_match', path: '/c.ts', replace_from: aa, replace_to: aa, old_string: '2', new_string: '3' })
    expect(stale).toContain('[E_STALE_ANCHOR]')

    const [fresh] = anchorsOf(diff.split('\n').filter(line => line.startsWith('+')).join('\n'))
    const missing = await call($, { tool: 'mcp__hashline__replace_match', path: '/c.ts', replace_from: fresh, replace_to: fresh, old_string: 'zzz', new_string: 'q' })
    expect(missing).toContain('[E_SUBSTRING_NOT_FOUND]')

    const reread = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/c.ts' }))
    await call($, { tool: 'mcp__hashline__insert', path: '/c.ts', anchor: reread[0], direction: 'after', text: '// mid' })
    expect(files['/c.ts']).toBe('const a = 2\n// mid\nconst b = 2\n')

    await call($, { tool: 'mcp__hashline__undo_last_change', path: '/c.ts' })
    expect(files['/c.ts']).toBe('const a = 2\nconst b = 2\n')
  })

  test('undo refuses with nothing to undo and after an outside change', async ($, on) => {
    const files: Record<string, string> = { '/u.ts': 'a\n' }
    disk(on, files)
    const none = await call($, { tool: 'mcp__hashline__undo_last_change', path: '/u.ts' })
    expect(none).toContain('[E_NO_UNDO]')
    const [a] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/u.ts' }))
    await call($, { tool: 'mcp__hashline__insert', path: '/u.ts', anchor: a, direction: 'after', text: 'b' })
    files['/u.ts'] = 'a\nb\nc\n'
    const changed = await call($, { tool: 'mcp__hashline__undo_last_change', path: '/u.ts' })
    expect(changed).toContain('[E_RANGE_STALE]')
    expect(files['/u.ts']).toBe('a\nb\nc\n')
  })

  test('undo copies are kept for the 50 most recent files', { timeoutMs: 30_000 }, async ($, on) => {
    const files: Record<string, string> = {}
    for (let k = 0; k <= 50; k++) files[`/f${k}.txt`] = 'a\n'
    disk(on, files)
    for (let k = 0; k <= 50; k++) {
      await call($, { tool: 'mcp__hashline__read', path: `/f${k}.txt` })
      await call($, { tool: 'mcp__hashline__insert', path: `/f${k}.txt`, direction: 'after', text: 'b' })
    }
    expect(await call($, { tool: 'mcp__hashline__undo_last_change', path: '/f0.txt' })).toContain('[E_NO_UNDO]')
    expect(await call($, { tool: 'mcp__hashline__undo_last_change', path: '/f1.txt' })).toContain('Reverted')
  })

  test('an edit of a very large file keeps no undo copy and says so', async ($, on) => {
    const files: Record<string, string> = { '/huge.txt': `${'z'.repeat(1_100_000)}\n` }
    disk(on, files)
    await call($, { tool: 'mcp__hashline__read', path: '/huge.txt' })
    const edited = await call($, { tool: 'mcp__hashline__insert', path: '/huge.txt', direction: 'after', text: 'end' })
    expect(edited).toContain('No undo kept')
    expect(await call($, { tool: 'mcp__hashline__undo_last_change', path: '/huge.txt' })).toContain('[E_NO_UNDO]')
  })

  test('insert without an anchor fills an empty file', async ($, on) => {
    const files: Record<string, string> = { '/d.ts': '' }
    disk(on, files)
    await call($, { tool: 'mcp__hashline__read', path: '/d.ts' })
    await call($, { tool: 'mcp__hashline__insert', path: '/d.ts', direction: 'after', text: 'hello' })
    expect(files['/d.ts']).toBe('hello\n')
  })

  test('read pages by offset and limit and stops at 50KB', async ($, on) => {
    const ten = Array.from({ length: 10 }, (_, k) => `line ${k + 1}`).join('\n') + '\n'
    const wide = Array.from({ length: 60 }, () => 'w'.repeat(1000)).join('\n') + '\n'
    const files: Record<string, string> = { '/ten.txt': ten, '/wide.txt': wide }
    disk(on, files)
    const page = await call($, { tool: 'mcp__hashline__read', path: '/ten.txt', offset: 3, limit: 2 })
    expect(page).toContain('lines 3-4 of 10')
    expect(page).toContain('│line 3')
    expect(page).not.toContain('│line 5')
    expect(page).toContain('read with offset=5')
    expect(await call($, { tool: 'mcp__hashline__read', path: '/ten.txt', offset: 11 })).toContain('[E_BAD_SHAPE]')
    const cut = await call($, { tool: 'mcp__hashline__read', path: '/wide.txt' })
    expect(cut).toMatch(/lines 1-(4\d|5\d) of 60/)
    expect(cut).toContain('more lines; read with offset=')
  })

  test('read refuses binary, oversized and missing files', async ($, on) => {
    const files: Record<string, string> = { '/bin.dat': 'a\0b', '/big.txt': 'x'.repeat(4 * 1024 * 1024 + 1) }
    disk(on, files)
    expect(await call($, { tool: 'mcp__hashline__read', path: '/bin.dat' })).toContain('[E_BINARY]')
    expect(await call($, { tool: 'mcp__hashline__read', path: '/big.txt' })).toContain('[E_FILE_TOO_LARGE]')
    const missing = await call($, { tool: 'mcp__hashline__read', path: '/nope.txt' })
    expect(missing).toContain('[E_NOT_FOUND]')
    expect(missing).toContain('Write')
  })

  test('a flipped range is edited and noted', async ($, on) => {
    const files: Record<string, string> = { '/r.txt': 'a\nb\nc\n' }
    disk(on, files)
    const [a, , c] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/r.txt' }))
    const out = await call($, { tool: 'mcp__hashline__replace', path: '/r.txt', remove_from: c, remove_to: a, text: 'x' })
    expect(out).toContain('[W_BAD_SHAPE]')
    expect(files['/r.txt']).toBe('x\n')
  })

  test('a pasted row works as an anchor', async ($, on) => {
    const files: Record<string, string> = { '/p.txt': 'one\ntwo\n' }
    disk(on, files)
    const [, two] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/p.txt' }))
    await call($, { tool: 'mcp__hashline__replace', path: '/p.txt', remove_from: `${two}│two`, remove_to: `+${two}│two`, text: 'TWO' })
    expect(files['/p.txt']).toBe('one\nTWO\n')
  })

  test('edits keep CRLF files CRLF and mixed files mixed', async ($, on) => {
    const files: Record<string, string> = { '/crlf.txt': 'a\r\nb\r\n', '/mixed.txt': 'a\nb\r\nc\n' }
    disk(on, files)
    const [a] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/crlf.txt' }))
    await call($, { tool: 'mcp__hashline__insert', path: '/crlf.txt', anchor: a, direction: 'after', text: 'x' })
    expect(files['/crlf.txt']).toBe('a\r\nx\r\nb\r\n')
    const [, , c] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/mixed.txt' }))
    await call($, { tool: 'mcp__hashline__replace', path: '/mixed.txt', remove_from: c, remove_to: c, text: 'C' })
    expect(files['/mixed.txt']).toBe('a\nb\r\nC\n')
  })

  test('parallel reads mint disjoint anchors and parallel edits both land', async ($, on) => {
    const files: Record<string, string> = { '/one.txt': 'a\nb\nc\n', '/two.txt': 'd\ne\nf\n' }
    disk(on, files)
    const [one, two] = await Promise.all([
      call($, { tool: 'mcp__hashline__read', path: '/one.txt' }),
      call($, { tool: 'mcp__hashline__read', path: '/two.txt' }),
    ])
    const all = [...anchorsOf(one), ...anchorsOf(two)]
    expect(all.length).toBe(6)
    expect(new Set(all).size).toBe(6)
    await Promise.all([
      call($, { tool: 'mcp__hashline__insert', path: '/one.txt', direction: 'after', text: 'x' }),
      call($, { tool: 'mcp__hashline__insert', path: '/one.txt', direction: 'after', text: 'y' }),
    ])
    const lines = files['/one.txt']!.split('\n')
    expect(lines.length).toBe(6)
    expect(lines).toContain('x')
    expect(lines).toContain('y')
  })

  test('an edit after a change on disk mints anchors twice in one call', async ($, on) => {
    const files: Record<string, string> = { '/twice.txt': 'a\nb\n' }
    disk(on, files)
    const [a] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/twice.txt' }))
    files['/twice.txt'] = 'a\nB\n'
    const out = await call($, { tool: 'mcp__hashline__insert', path: '/twice.txt', anchor: a, direction: 'after', text: 'x\ny' })
    expect(files['/twice.txt']).toBe('a\nx\ny\nB\n')
    const reread = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/twice.txt' }))
    expect(new Set(reread).size).toBe(4)
    expect(out).toContain('-0 +2 at line 2')
  })

  test('the built-in Edit is denied on files hashline serves', async ($, on) => {
    disk(on, { '/a.ts': 'a\n' })
    on('tool.call', () => ({ result: 'ran' }))
    const out = await call($, { tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b' })
    expect(out).toContain('hashline')
  })

  test('the built-in Edit runs on files hashline refuses', async ($, on) => {
    disk(on, { '/bin.dat': 'a\0b' })
    on('tool.call', () => ({ result: 'ran' }))
    expect(await call($, { tool: 'Edit', file_path: '/bin.dat', old_string: 'a', new_string: 'b' })).toBe('ran')
    expect(await call($, { tool: 'Edit', file_path: '/new.ts', old_string: '', new_string: 'b' })).toBe('ran')
  })

  test('disableEdit off leaves the built-in Edit alone', { options: { disableEdit: false } }, async ($, on) => {
    disk(on, { '/a.ts': 'a\n' })
    on('tool.call', () => ({ result: 'ran' }))
    expect(await call($, { tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b' })).toBe('ran')
  })

  test('tool descriptions pin the hashline tools and defer Edit', async ($, on) => {
    on('tool.describe', ($, e) => ({ description: e.description }))
    const provider = { plugin: 'engine', tier: 'core' } as never
    const read = await $.tool.describe({ tool: 'mcp__hashline__read', description: 'r', provider })
    expect(read.isDeferred).toBe(false)
    const undo = await $.tool.describe({ tool: 'mcp__hashline__undo_last_change', description: 'u', provider })
    expect(undo.isDeferred).toBe(undefined)
    const edit = await $.tool.describe({ tool: 'Edit', description: 'e', provider })
    expect(edit.isDeferred).toBe(true)
    expect(edit.description).toContain('hashline tools refuse')
    const builtin = await $.tool.describe({ tool: 'Read', description: 'Reads files.', provider })
    expect(builtin.description).toContain('Reads files.')
    expect(builtin.description).toContain('mcp__hashline__read')
  })

  test('private-use glyphs read as tokens and edit back into glyphs', async ($, on) => {
    const files: Record<string, string> = { '/e.kdl': `left "${POWERLINE} x"\nicon "${GITHUB}"\n` }
    disk(on, files)
    const read = await call($, { tool: 'mcp__hashline__read', path: '/e.kdl' })
    expect(read).toContain(`left "${token('E0B0')} x"`)
    const [left, icon] = anchorsOf(read)

    const diff = await call($, { tool: 'mcp__hashline__replace_match', path: '/e.kdl', replace_from: left, replace_to: left, old_string: token('E0B0'), new_string: token('E0B2') })
    expect(diff).toContain(`-left "${token('E0B0')} x"`)
    await call($, { tool: 'mcp__hashline__replace', path: '/e.kdl', remove_from: icon, remove_to: icon, text: `icon "${token('F113')} ${token('E0A0')}"` })
    expect(files['/e.kdl']).toBe(`left "${String.fromCharCode(0xe0b2)} x"\nicon "${GITHUB} ${String.fromCharCode(0xe0a0)}"\n`)
  })

  test('replace refuses to retype a literal token', async ($, on) => {
    const files: Record<string, string> = { '/f.lua': `sep = "${token('E0B0')}"\n` }
    disk(on, files)
    const [sep] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/f.lua' }))
    const out = await call($, { tool: 'mcp__hashline__replace', path: '/f.lua', remove_from: sep, remove_to: sep, text: `sep = "${token('E0B0')}" -- x` })
    expect(out).toContain('[E_LITERAL_TOKEN]')
    expect(files['/f.lua']).toBe(`sep = "${token('E0B0')}"\n`)
  })

  test('a backslash token writes a literal backslash-u escape', async ($, on) => {
    const files: Record<string, string> = { '/h.json': '{}\n' }
    disk(on, files)
    const [brace] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/h.json' }))
    await call($, { tool: 'mcp__hashline__insert', path: '/h.json', anchor: brace, direction: 'before', text: `"${token('005C')}uE0B0"` })
    expect(files['/h.json']).toBe(`"${String.fromCharCode(92)}uE0B0"\n{}\n`)
  })

  test('replace_match diffs show only the lines that changed', async ($, on) => {
    const files: Record<string, string> = { '/g.txt': 'one\ntwo\nthree\nfour\nfive\n' }
    disk(on, files)
    const [first, , three, , last] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/g.txt' }))
    const diff = await call($, { tool: 'mcp__hashline__replace_match', path: '/g.txt', replace_from: first, replace_to: last, old_string: 'o', new_string: '0' })
    expect(files['/g.txt']).toBe('0ne\ntw0\nthree\nf0ur\nfive\n')
    expect(diff).toContain('-3 +3')
    expect(diff).not.toContain('-three')
    expect(diff).toContain(` ${three}│three`)
    expect(diff.split('\n').filter(line => line.startsWith('-')).length).toBe(3)
    expect(diff.split('\n').filter(line => line.startsWith('+')).length).toBe(3)
  })

  test('an edit result draws as a unified diff and keeps its text for the model', async ($, on) => {
    const files: Record<string, string> = { '/i.ts': 'one\ntwo\nthree\n' }
    disk(on, files)
    const [one, two, three] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/i.ts' }))
    const tool = 'mcp__hashline__replace'
    const text = await call($, { tool, tool_use_id: 'toolu_diff', path: '/i.ts', remove_from: two, remove_to: two, text: 'TWO' })
    const [, fresh] = text.match(/^\+([A-Z][a-z]{3})│TWO$/m) ?? []
    expect(fresh === undefined).toBe(false)
    for (const surface of ['terminal', 'desktop'] as const) {
      const props = { tool_use_id: 'toolu_diff', tool, output: text, isErrored: false }
      const ui = await $.ui.mount({ plugin: 'hashline', surface, component: 'ToolResult', requestId: 'toolu_diff', props })
      const code = await ui.find({ type: 'Code' })
      expect(code?.props.format).toBe('diff')
      expect(code?.props.path).toBe('/i.ts')
      expect(code?.props.source).toBe(`@@ -1,3 +1,3 @@\n ${one}│one\n-    │two\n+${fresh}│TWO\n ${three}│three`)
      await ui.unmount()
    }
  })

  test('undo draws the lines it restored', async ($, on) => {
    const files: Record<string, string> = { '/j.ts': 'a\nb\n' }
    disk(on, files)
    const [a, b] = anchorsOf(await call($, { tool: 'mcp__hashline__read', path: '/j.ts' }))
    await call($, { tool: 'mcp__hashline__insert', path: '/j.ts', anchor: a, direction: 'after', text: 'mid' })
    const tool = 'mcp__hashline__undo_last_change'
    const text = await call($, { tool, tool_use_id: 'toolu_undo', path: '/j.ts' })
    const props = { tool_use_id: 'toolu_undo', tool, output: text, isErrored: false }
    const ui = await $.ui.mount({ plugin: 'hashline', surface: 'terminal', component: 'ToolResult', requestId: 'toolu_undo', props })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe(`@@ -1,3 +1,2 @@\n ${a}│a\n-    │mid\n ${b}│b`)
  })
})

describe('permissions', () => {
  const ASK_OWN = 'Claude requested permissions to use mcp__hashline__insert, but you haven\'t granted it yet.'

  test('reads take Read\'s verdict for the file, in plan mode too', async ($, on) => {
    disk(on, { '/s.txt': 'a\n', '/.env': 'S=1\n' }, (tool, input) => {
      if (tool === 'Read') return input.file_path === '/.env' ? { decision: 'deny', reason: 'Read(/.env) is denied.' } : { decision: 'allow' }
      return { decision: 'ask', reason: 'Cannot call mcp__hashline__read while in plan mode.' }
    })
    expect((await $.tool.check({ tool: 'mcp__hashline__read', input: { path: '/s.txt' } })).decision).toBe('allow')
    const denied = await $.tool.check({ tool: 'mcp__hashline__read', input: { path: '/.env' } })
    expect(denied.decision).toBe('deny')
    expect(denied.reason).toBe('Read(/.env) is denied.')
  })

  test('an Edit allow passes edits, as acceptEdits does', async ($, on) => {
    disk(on, { '/a.ts': 'one\n' }, tool => (tool === 'Edit' ? { decision: 'allow' } : { decision: 'ask', reason: ASK_OWN }))
    expect((await $.tool.check({ tool: 'mcp__hashline__insert', input: { path: '/a.ts' } })).decision).toBe('allow')
  })

  test('an Edit deny refuses edits, even with the hashline tool allowed', async ($, on) => {
    disk(on, { '/a.ts': 'one\n' }, tool =>
      tool === 'Edit'
        ? { decision: 'deny', reason: 'Edit(/a.ts) is denied.' }
        : { decision: 'allow', rule: 'mcp__hashline__insert' },
    )
    const denied = await $.tool.check({ tool: 'mcp__hashline__insert', input: { path: '/a.ts' } })
    expect(denied.decision).toBe('deny')
    expect(denied.reason).toBe('Edit(/a.ts) is denied.')
  })

  test('an Edit ask is the verdict, so the engine\'s dialog or classifier decides', async ($, on) => {
    const reason = 'Claude requested permissions to edit /a.ts'
    disk(on, { '/a.ts': 'one\n' }, tool => (tool === 'Edit' ? { decision: 'ask', reason } : { decision: 'ask', reason: ASK_OWN }))
    const asked = await $.tool.check({ tool: 'mcp__hashline__insert', input: { path: '/a.ts' } })
    expect(asked.decision).toBe('ask')
    expect(asked.reason).toBe(reason)
  })

  test('an allow rule naming the hashline tool cannot skip a protected file', async ($, on) => {
    const reason = 'Claude requested permissions to edit /a.ts which is a sensitive file.'
    disk(on, { '/a.ts': 'one\n' }, tool =>
      tool === 'Edit' ? { decision: 'ask', reason } : { decision: 'allow', rule: 'mcp__hashline__insert' },
    )
    const asked = await $.tool.check({ tool: 'mcp__hashline__insert', input: { path: '/a.ts' } })
    expect(asked.decision).toBe('ask')
    expect(asked.reason).toBe(reason)
  })

  test('a deny rule naming the hashline tool refuses it', async ($, on) => {
    disk(on, { '/a.ts': 'one\n' }, tool =>
      tool === 'Edit' ? { decision: 'allow' } : { decision: 'deny', reason: 'Denied by rule.', rule: 'mcp__hashline__insert' },
    )
    expect((await $.tool.check({ tool: 'mcp__hashline__insert', input: { path: '/a.ts' } })).decision).toBe('deny')
  })

  test('a deny from the mode alone gives way to an Edit allow', async ($, on) => {
    disk(on, { '/a.ts': 'one\n' }, tool => (tool === 'Edit' ? { decision: 'allow' } : { decision: 'deny', reason: 'Not pre-approved.' }))
    expect((await $.tool.check({ tool: 'mcp__hashline__insert', input: { path: '/a.ts' } })).decision).toBe('allow')
  })

  test('a refused call is passed on and leaves the file', async ($, on) => {
    const files: Record<string, string> = { '/a.ts': 'one\n' }
    const refusal = 'Permission to use mcp__hashline__insert has been denied.'
    disk(on, files, allowAll, tool => (tool === 'mcp__hashline__insert' ? { deny: refusal } : unanswered(tool)))
    await call($, { tool: 'mcp__hashline__read', path: '/a.ts' })
    const out = await call($, { tool: 'mcp__hashline__insert', path: '/a.ts', direction: 'after', text: 'two' })
    expect(out).toBe(refusal)
    expect(files['/a.ts']).toBe('one\n')
  })

  test('any other end of the permission flow stops the call', async ($, on) => {
    const files: Record<string, string> = { '/a.ts': 'one\n' }
    disk(on, files, allowAll, tool =>
      tool === 'mcp__hashline__insert' ? { result: 'Error: reworded', text: 'reworded', isError: true } : unanswered(tool),
    )
    await call($, { tool: 'mcp__hashline__read', path: '/a.ts' })
    const out = await call($, { tool: 'mcp__hashline__insert', path: '/a.ts', direction: 'after', text: 'two' })
    expect(out).toBe('Error: reworded')
    expect(files['/a.ts']).toBe('one\n')
  })
})
