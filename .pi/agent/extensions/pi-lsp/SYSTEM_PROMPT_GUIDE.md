# LSP system prompt guide

Use the `lsp` tool first for semantic code navigation when it is available.

- Check `lsp action=status` if server availability is unclear.
- Prefer `symbols` and `workspace_symbols` to find code by meaning, not filename guesses.
- Prefer `definition`, `references`, and `hover` over grep when tracing behavior.
- Use `diagnostics` and `actions` before making manual fixes.
- Use `rename` for symbol renames instead of search/replace.
- Fall back to plain file reads or text search only when LSP is unavailable or you need raw text.
- Remember: `line` and `character` are 1-based.
