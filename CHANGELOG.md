# Changelog

## 0.1.0 (2026-10-08)


### Features

* hash-anchored `read`, `replace`, `replace_match`, `insert` and `undo_last_change` tools
* calls go through Claude Code's own permission flow, held to the `Read` or `Edit` verdict for the same file
* the built-in `Edit` is denied on text files hashline serves, behind the `disableEdit` option
* line breaks are kept per line, so mixed-ending files stay mixed
* anchors never repeat within one file, and a change anywhere in a line makes its anchor stale
