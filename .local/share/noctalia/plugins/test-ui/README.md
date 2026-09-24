# Test UI

A deliberately static plugin for exercising the Noctalia v5 plugin surfaces. It
renders an email inbox that does not touch email: the messages are fixed test
data in `lib/inbox.luau`.

What it exercises:

- a `[[widget]]` bar entry using the imperative glyph + text row
- a `[[panel]]` entry rendering a declarative `ui.*` table
- shared state between entries through `noctalia.state`
- a `require()` module, translations, and a `ui.row` hover callback

## Plugin

| Field | Value |
| --- | --- |
| ID | `toms/test-ui` |
| Entries | Bar widget: `email`; panel: `inbox` |
| Panel command | `noctalia msg panel-toggle toms/test-ui:inbox` |

## Usage

Enable the plugin, then add the `email` widget to a bar:

```sh
noctalia msg plugins enable toms/test-ui
```

The bar reads `(1) new; (33) unread`. Left click opens the message table.

- Click a row to mark it read. The bar counter updates through `noctalia.state`.
- Hover a row to highlight it.
- The refresh button restores the default unread state.
- The close button dismisses the panel. Clicking outside does the same.

## Settings

None. Every value is hardcoded on purpose, so there is nothing to configure.

## IPC

```sh
noctalia msg panel-toggle toms/test-ui:inbox
noctalia msg plugin toms/test-ui:email focused say "hello"
```

The `say` event raises a notification. The widget also declares no gesture
bindings, so `onClick` reaches the script unimpeded.

## Notes

No network calls, no subprocesses, and no filesystem access. `noctalia.state` is
used only to share counts between the widget and the panel, and it is in-memory,
so the read state resets when the plugin reloads.

`panel.render()` rebuilds the whole tree on hover and on click. With 38 rows that
is fine, and it keeps the code obvious, but a larger list would want to re-render
only the affected rows.
