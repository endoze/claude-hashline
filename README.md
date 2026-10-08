# hashline

A Claude Code mod that edits files by hash anchors instead of line numbers or fuzzy string matching. `read` puts a stable 4-letter anchor on every line, and the edit tools address lines only by those anchors. An anchor stays valid across Claude's own edits and goes stale when the line changes on disk, so an edit never lands on a line Claude has not seen.

## Install

At the prompt in a terminal session:

```
/plugin install hashline --marketplace endoze/claude-hashline
```

Answer `y` to add the marketplace, then pick a scope. `claude plugin update hashline` pulls new releases.

## What it changes

- Adds five tools: `mcp__hashline__read`, `replace`, `replace_match`, `insert` and `undo_last_change`.
- Denies the built-in `Edit` on text files the hashline tools can serve. `Edit` still works on files hashline refuses (binary, or over 4 MiB). Turn this off with `disableEdit` in `/config`.
- Adds a line to `Read`'s description pointing Claude at `mcp__hashline__read` for files it will edit.
- Draws each edit's result in the transcript as a unified diff, each row led by its line's anchor so you can name lines back to Claude.

A read looks like this:

```
src/app.ts · lines 1-3 of 3
Alsp│import { run } from './run'
Mdvk│
Qbxe│run()
```

and an edit names lines by anchor:

```json
{ "path": "src/app.ts", "remove_from": "Qbxe", "remove_to": "Qbxe", "text": "await run()" }
```

## Permissions

hashline asks when the built-in tool would for the same file: `read` is checked as `Read`, the edit tools and undo as `Edit`. Your `Read` and `Edit` rules, acceptEdits mode, and sensitive-file protection all apply.

An allow rule naming a hashline tool doesn't skip those questions, so "don't ask again" won't stick. Use acceptEdits or an `Edit(...)` allow rule instead.

Hooks matched on `Edit` or `Read` don't run for hashline calls, so a formatter hooked to `PostToolUse` on `Edit` stops firing. A `PreToolUse` hook matched on `mcp__hashline__.*` does run. `PostToolUse` never fires for hashline, and `PostToolUseFailure` fires for every call, including successful ones.

## Errors

Refusals start with a code the model can act on.

| Code | Meaning |
| --- | --- |
| `E_NOT_FOUND` | The path does not exist. Create new files with `Write`. |
| `E_BAD_SHAPE` | A missing or malformed argument, or `offset` past the end. |
| `E_FILE_TOO_LARGE` | The file is over 4 MiB or 228,488 lines. |
| `E_BINARY` | The file holds a NUL byte. |
| `E_STALE_ANCHOR` | The anchor is not from this file in this session. Read again. |
| `E_RANGE_STALE` | The line changed on disk since it was read, or undo would discard an outside change. |
| `E_SUBSTRING_NOT_FOUND` | `replace_match` found no `old_string` in the range. |
| `E_LITERAL_TOKEN` | `replace` would turn a literal `⟦U+XXXX⟧` token into a glyph. |
| `E_LONG_LINE` | `replace` on a line read showed cut. Use `replace_match`. |
| `E_NO_UNDO` | No hashline edit of the file to undo. |
| `E_INTERNAL` | The tool or its permission check failed. Read the file again before retrying. |

`W_BAD_SHAPE` is a warning: a flipped range was edited as if given in order.

## Limits

- Files up to 4 MiB and 228,488 lines.
- One `read` serves up to 2,000 rows or 50 KB; page with `offset` and `limit`.
- Rows longer than 2,000 characters are shown cut.
- One undo level per file, kept for the 50 most recently edited files under 1M characters.
- The transcript draws diffs for the 500 most recent edits; older ones show their text.
- Private-use glyphs (U+E000 to U+F8FF, powerline and nerd font icons) travel as `⟦U+XXXX⟧` tokens.

## Development

```
claude --plugin-dir .
```

The first load writes the engine's type declarations into `.claude-plugin/types/` (gitignored). After that, `tsc -p .` type-checks the mod. Until then it fails, since `tsconfig.json` extends a file in that folder.

```
claude plugin validate .
claude plugin test .
```

## License

MIT
