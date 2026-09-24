# Noctalia plugin development

Reference for Noctalia v5 plugins. Everything here was verified against
Noctalia v5.0.1 on this machine, with the official `noctalia.d.luau` definitions
and the two plugin repos as sources of truth.

Sources: `docs.noctalia.dev/noctalia/plugins/development/`,
`github.com/noctalia-dev/official-plugins` (reference plugin plus the API
definitions), `github.com/noctalia-dev/community-plugins` (publishing rules and
CI validator).

## Contents

- [Where things live](#where-things-live)
- [What a plugin is](#what-a-plugin-is)
- [Manifest reference](#manifest-reference)
- [Entry types](#entry-types)
- [Settings](#settings)
- [Translations](#translations)
- [Entry scripts](#entry-scripts)
- [Runtime API](#runtime-api)
- [Sharing data between entries](#sharing-data-between-entries)
- [Modules with require](#modules-with-require)
- [Declarative UI](#declarative-ui)
- [Surfaces: what works where](#surfaces-what-works-where)
- [Gotchas](#gotchas)
- [Local development loop](#local-development-loop)
- [Debugging](#debugging)
- [Publishing](#publishing)
- [Minimal plugin template](#minimal-plugin-template)

## Where things live

The most common mistake is putting a v5 plugin somewhere v5 does not read.
Noctalia v4 used `~/.config/noctalia/plugins/` with `manifest.json` and QML
files. v5 reads none of that.

| What | Path |
| --- | --- |
| Hand-written config, any `*.toml` | `~/.config/noctalia/` |
| GUI-managed overrides (wins over the above) | `~/.local/state/noctalia/settings.toml` |
| Local plugins, hand-placed | `~/.local/share/noctalia/plugins/<plugin>/` |
| Git source repo caches | `~/.local/state/noctalia/plugins/sources/` |
| Plugins materialized from git sources | `~/.local/state/noctalia/plugins/materialized/` |
| Custom palettes | `~/.config/noctalia/palettes/` |
| Lock screen PAM config | `~/.config/noctalia/pam/password.conf` |

Environment overrides exist for each root: `NOCTALIA_CONFIG_HOME`,
`NOCTALIA_STATE_HOME`, `NOCTALIA_DATA_HOME`, and `NOCTALIA_LOG_LEVEL`.

Dead v4 paths, safe to delete: `~/.config/noctalia/plugins/`,
`plugins.json`, `settings.json`, `colorschemes/`, and the MD3 `colors.json`
palette. `noctalia msg plugins list` never shows them, and the v5 binary has no
references to them. The `colors.json` strings in the binary belong to the
Firefox/pywalfox theme integration, which is a different file in the Firefox
profile.

## What a plugin is

A directory with a TOML manifest and one Luau script per entry. There is no
build step and no SDK to install.

```
hello/
  plugin.toml            manifest: identity, entries, settings schema
  hello.luau             entry script
  README.md              rendered as the plugin page on noctalia.dev
  thumbnail.webp         960x540 card image
  translations/en.json   every label_key and description_key the manifest uses
  lib/                   optional shared modules
```

The runtime model matters when you design:

- Each entry script runs in **its own isolated Luau VM**. Entries do not share
  Lua memory, module state, or globals. Two entries requiring the same module
  get separate instances.
- Each VM runs **off the UI thread** with a per-call time budget, so a slow or
  crashing script cannot stall the shell.
- Plugins are **trusted and unsandboxed**. Installing one is equivalent to
  running a script you own. It can read and write files, spawn processes, and
  use the network as your user. There is no permission broker. The community
  repo compensates with review rules (see [Publishing](#publishing)).

Every `entry` field in the manifest is a plugin-relative path to a Luau script.
CI checks that the path exists and stays inside the plugin directory.

## Manifest reference

```toml
id          = "me/hello"        # "<author>/<plugin>"
name        = "Hello"
version     = "1.0.0"           # strict MAJOR.MINOR.PATCH, no prerelease suffix
plugin_api  = 3                 # oldest API level you require
author      = "me"
license     = "MIT"
icon        = "mail"
description = "One line, shown in the plugin store."
tags        = ["demo", "bar"]
dependencies = ["slurp"]        # external commands the plugin shells out to
```

Required root fields: `id`, `name`, `version`, `plugin_api`.

Both id segments must be lowercase and match `[a-z0-9][a-z0-9._-]*`. The
directory name must equal the segment after the `/`, so `me/hello` lives in
`hello/`. An entry is addressed as `<author>/<plugin>:<entry-id>`.

### plugin_api is a minimum, not a target

API levels are cumulative. Declaring level 22 means "I need everything up to
22", and the plugin runs on any shell that supports 22 or higher. Declaring a
higher level than you need silently excludes every older shell, so declare the
oldest level that contains everything you use.

Noctalia v5.0.1 supports levels 3 through 30. The current docs list 3 through
32, with 31 and 32 marked unreleased, so a plugin declaring either of those will
not run on v5.0.1.

| Level | Shipped in | Adds |
| --- | --- | --- |
| 3 | v5.0.0-beta.3 | mandatory `plugin_api` declaration |
| 4 | v5.0.0-beta.4 | `noctalia.httpStream` |
| 5 | v5.0.0-beta.4 | `ui.dragSource`, `ui.dropZone` |
| 6 | v5.0.0-beta.4 | `string_map` setting type |
| 7 | v5.0.0-beta.4 | `allow_insecure_tls` HTTP request option |
| 8 | v5.0.0-beta.4 | `dismiss_on_outside_click` panel option |
| 9 | v5.0.0-beta.5 | Luau closures in UI callback props |
| 10 | v5.0.0-beta.5 | `keyboard_focus` panel option |
| 11 | v5.0.0-beta.5 | `persistent` panel option |
| 12 | v5.0.0-beta.5 | `systemStats`, `cpuCores`, `nowMs` |
| 13 | v5.0.0-beta.5 | `capture_keys` panel option and `onKey` |
| 14 | v5.0.0-beta.5 | `[widget.actions]` gesture defaults |
| 15 | v5.0.0-beta.6 | `noctalia.openSettings` |
| 16 | v5.0.0-beta.6 | disk mount and stat APIs, per-interface network rates |
| 17 | v5.0.0-beta.7 | services start on enable; `onExit(signal, reason)` |
| 18 | v5.0.0-beta.7 | `panel.setNeedsFrameTick`, `onFrameTick` |
| 19 | v5.0.0-beta.7 | timezone support, `timeFormat`, `dateFormat` |
| 20 | v5.0.0-beta.7 | `noctalia.sound` |
| 21 | v5.0.0-beta.8 | `ui.markdown`, `submitOnEnter`, scroll callbacks |
| 22 | v5.0.0-beta.8 | `require("./path.luau")` modules |
| 23 | v5.0.0-beta.8 | `noctalia.readFileAsync` |
| 24 | v5.0.0-beta.9 | argv form of `runAsync` |
| 25 | v5.0.0-beta.9 | `wallpaperPath`, `setWallpaperMask` |
| 26 | v5.0.0-beta.9 | `noctalia.getSetting` |
| 27 | v5.0.0-beta.9 | `frameVisible` on `ui.input` |
| 28 | v5.0.0-beta.9 | `panel.openContextMenu` |
| 29 | v5.0.1 | `onPointerMove`, `onPointerLeave` on `ui.graph` |
| 30 | v5.0.1 | `layer` panel option |
| 31 | unreleased | `noctalia.getColor` |
| 32 | unreleased | `tooltip` on `ui.box`, `ui.row`, `ui.column`, `ui.image` |

Raising the declaration drops the plugin from every shell below that level. A
source repo can keep those users covered by publishing older revisions in its
catalog, see [Your own source repo](#your-own-source-repo).

## Entry types

| Table | What it is | Addressing |
| --- | --- | --- |
| `[[widget]]` | bar widget | `<id>:<entry>` plus an output selector |
| `[[shortcut]]` | control-center quick-toggle tile | `<id>:<entry>` |
| `[[launcher_provider]]` | answers launcher queries behind a prefix | `<id>:<entry>` |
| `[[desktop_widget]]` | tile on the desktop, declarative tree | `<id>:<entry>` |
| `[[panel]]` | pop-up surface that takes keyboard focus | `<id>:<entry>` |
| `[[service]]` | headless background loop, no UI | `<id>:<entry>` |

```toml
[[widget]]
id    = "hello"
entry = "hello.luau"

[[panel]]
id              = "inbox"
entry           = "inbox.luau"
width           = 560
height          = 420
placement       = "attached"     # or "floating"
open_near_click = true           # opens under the widget that toggled it
```

Panel size is host-owned. Declare `width` and `height` on the entry, because
there is no `setSize` at runtime. `placement` takes `attached` (drops down from
the bar edge) or `floating` (detached, where `position` applies). The remaining
panel keys and the API level that introduced each one:
`dismiss_on_outside_click` (8), `keyboard_focus` (10), `persistent` (11),
`capture_keys` (13), `layer` (30).

A declared widget action binding takes precedence over your script callback. You
ship defaults with `[widget.actions]`, and the user can override them per
instance.

## Settings

Two scopes. Plugin-level `[[setting]]` at the manifest root is shared by every
entry and edited under Settings, Plugins. Entry-level `[[widget.setting]]`,
`[[panel.setting]]` and so on are per-entry. When both declare the same key, the
entry value wins for that entry.

```toml
[[setting]]
key             = "video_source"
type            = "select"
label_key       = "settings.video_source.label"
description_key = "settings.video_source.description"
default         = "portal"
options = [
  { value = "focused", label_key = "settings.video_source.options.focused" },
  { value = "portal",  label_key = "settings.video_source.options.portal" },
]

[[setting]]
key          = "frame_rate"
type         = "int"
label_key    = "settings.frame_rate.label"
default      = 60
min          = 1
max          = 240

[[setting]]
key          = "video_qp"
type         = "int"
label_key    = "settings.video_qp.label"
default      = 25
visible_when = { key = "video_bitrate_mode", values = ["qp"] }
```

Types: `string`, `string_list`, `string_map`, `bool`, `int`, `double`, `select`,
`file`, `folder`, `glyph`, `color`.

Two things trip people up. Labels and descriptions are always translation keys
(`label_key`, `description_key`), never literal `label` fields, so a plugin with
settings needs `translations/en.json` even when it has no other user-facing
strings. And `getConfig` on a key you did not declare returns `nil` and logs a
warning rather than falling back to a default.

`visible_when` gates a setting on another value. `advanced = true` hides it
behind the advanced toggle. Every declared key is seeded from its `default`
before the script ever reads it, so `noctalia.getConfig` is total for declared
keys.

## Translations

`translations/<lang>.json`, looked up with dotted paths against nested objects:

```json
{
  "counts": { "new": "new", "unread": "unread" },
  "panel": {
    "title": "Inbox",
    "column": { "from": "FROM", "subject": "SUBJECT", "time": "TIME" }
  }
}
```

`noctalia.tr("panel.column.from")` resolves to `"FROM"`. Keys in the JSON must be
single segments; a dot inside a JSON key is rejected by the community validator.
`noctalia.trp(key, count)` handles plurals with `one` and `other` forms.

Write `translations/en.json` only. Other locales come from
i18n.noctalia.dev, and hand-editing them gets overwritten on the next pull.

## Entry scripts

You define global functions and the host calls them. `--!nonstrict` at the top
of every file matches the committed `.luaurc`.

| Callback | Runs for |
| --- | --- |
| `update()` | bar widget, desktop widget, service, at `setUpdateInterval` |
| `onIpc(event, payload)` | any entry |
| `onClick()` / `onRightClick()` | shortcut, bar widget |
| `onMiddleClick()` | bar widget, see the middle-click gotcha |
| `onHover(entered)` | bar widget pointer enter and leave |
| `onScroll(axis, steps, startsGesture)` | bar widget |
| `onQuery(text)` / `onActivate(id)` | launcher provider |
| `onFrameTick(deltaMs)` | desktop widget, or an open panel after `setNeedsFrameTick(true)` |
| `onAudioSpectrum(valuesCsv, stateCsv)` | audio-reactive bar widget |
| `onOpen(context)` / `onClose()` | panel lifecycle |
| `onKey(chord, pressed)` | panel, for chords declared in `capture_keys` |
| `onConfigChanged()` | service, after settings change |
| `onEnable()` | service, plugin explicitly enabled |
| `onOutputsChanged()` | service, output set or geometry changed |
| `onExit(signal, reason)` | any entry teardown |

`reason` is `"reload"`, `"disable"`, `"uninstall"`, or `"shutdown"`. The top
level of the script runs once at load, which is where you set up state and
register `noctalia.state.watch` handlers.

Only callbacks the entry defines are called. Globals registered after a
load-time error do not exist, so keep top-level side effects below your function
definitions.

## Runtime API

Seven namespaces.

`noctalia.*` covers logging, update interval, config reads (`getConfig`,
`getSetting`), outputs and wallpaper, `togglePanel`, notifications, clipboard,
time formatting, system stats, subprocesses (`runAsync` with a string or argv,
`runStream`, `commandExists`, `processMatches`), filesystem (`readFile`,
`writeFile`, `listDir`, `pluginDir`, `pluginDataDir`), fonts, HTTP (`http`,
`httpStream`, `download`), JSON, i18n, fuzzy matching, and sound.

`barWidget.*`, `shortcut.*`, `launcher.*`, `desktopWidget.*`, and `panel.*` are
the per-entry presentation APIs. `ui.*` builds the declarative tree.

Presentation methods are flat setters that persist until replaced:

```lua
barWidget.setGlyph("mail")
barWidget.setGlyphColor("primary")          -- "on_surface" restores the default
barWidget.setText("(1) new")
barWidget.setTooltip("Static inbox")
```

`barWidget.render(tree)` is the declarative alternative to `setText`/`setGlyph`.
Keyboard controls are not supported in the bar, because the bar never takes
keyboard focus.

## Sharing data between entries

Entries cannot share Lua values, so they exchange plain data through
`noctalia.state`:

```lua
noctalia.state.set("inbox", { new = 1, unread = 33 })

local shared = noctalia.state.get("inbox")

noctalia.state.watch("inbox", function(value)
  published = value
  render()
end)
```

Values must be plain data: strings, numbers, booleans, and tables of those. The
state store is in-memory and lives as long as the process, so it survives an
entry reload. That also means it is the wrong place for durable data, and any
cache you keep there must be keyed by the config it depends on.

For anything that must outlive the shell, use `noctalia.pluginDataDir()`. Do not
write to `noctalia.pluginDir()`: for git-installed plugins it is a runtime copy
that gets rewritten on update.

## Modules with require

`plugin_api = 22` enables splitting logic into modules:

```lua
local inbox = require("./lib/inbox.luau")
```

Relative paths only, no package search path, and a module must return exactly
one non-nil value. Inside a module, `_G` is the module environment rather than
the entry's, but the sandboxed globals (`noctalia`, `ui`, and the rest) are still
visible. Watch handlers, subprocess callbacks, and HTTP callbacks cannot run in
module top-level code; register those from the entry or from a function the
entry calls.

A module that failed to load is not cached or watched, so creating a previously
missing module does not reload anything by itself.

## Declarative UI

Build a tree with `ui.*` constructors and hand it to the surface:

```lua
panel.render(ui.column({ flexGrow = 1, gap = 12 }, {
  ui.row({ align = "center", gap = 8 }, {
    ui.glyph({ name = "mail", size = 18, color = "primary" }),
    ui.label({ text = "Inbox", fontSize = 16, fontWeight = "bold" }),
    ui.spacer({ flexGrow = 1 }),
    ui.button({ glyph = "close", variant = "ghost", onClick = "onCloseClicked" }),
  }),
  ui.scroll({ flexGrow = 1, gap = 0 }, rows),
}))
```

The host diffs each tree against the previous one and updates retained native
controls, so re-rendering an unchanged tree costs almost nothing.

Only `column`, `row`, `scroll`, `dragSource`, and `dropZone` host children. The
rest are leaves: `box`, `label`, `markdown`, `glyph`, `image`, `separator`,
`spacer`, `progress`, `button`, `graph`, `input`, `select`, `slider`, `toggle`.

Every node accepts `key`, `width`, `height`, `flexGrow`, `opacity`, and
`visible`. Give repeated children a stable `key` so input text, hover state, and
closures stay aligned with their row across renders.

A callback prop takes either the name of a plugin global or a closure. A closure
is render-scoped: re-rendering replaces it, and an event on a node the current
tree no longer contains does nothing. Every argument arrives as a string.

```lua
ui.row({
  key = "message-" .. id,
  onClick = function() markRead(id) end,   -- closure
  onHover = "onRowHover",                  -- named global: onRowHover(state, key)
}, { ... })
```

Containers that declare only `onHover` pass clicks through to an enclosing
target. Adding `onClick` makes the whole container a click target and puts it in
the tab order.

Colors are a palette role (`"primary"`, `"on_surface"`), a role with alpha
(`"primary/0.6"`), or a hex value.

## Surfaces: what works where

Panels and desktop widgets share one vocabulary. Panels add the interactive
controls, because a panel takes keyboard focus while open.

| Control | Bar widget | Panel | Desktop widget |
| --- | --- | --- | --- |
| `column`, `row` and their children: `label`, `markdown`, `glyph`, `image`, `box`, `separator`, `spacer`, `progress`, `button`, `graph`, `toggle`, `slider` | yes | yes | yes |
| `ui.input`, `ui.select`, `ui.scroll` | skipped with a warning | yes | no |
| `ui.dragSource`, `ui.dropZone` | rejected with a log message | yes, API 5 | rejected with a log message |
| `tooltip` on `button`, `box`, `row`, `column`, `image` | API 32 | API 32 | never shown |

The three skipped controls are the only exclusions the docs state for the bar:
the bar never takes keyboard focus, so `ui.input`, `ui.select`, and `ui.scroll`
are dropped with a warning there. Pointer controls work, and a button renders
compact. Treat anything else in a bar tree as untested rather than guaranteed.

Two more layout rules. `ui.select` has no dropdowns inside a persistent panel.
And the bar clips its widget tree to the bar thickness, so keep a bar tree one
control tall and branch on `barWidget.isVertical()`.

## Gotchas

These cost real time when missed.

**Middle click is taken.** Every widget defaults to
`middle = "settings-open-widget"`, so `onMiddleClick` never fires until the
manifest or the user binds `middle = "none"`. Declare it in
`[widget.actions]` if you need the button.

**User bindings beat your script.** A gesture the user bound in their config
stops your matching callback. `enable_scroll = false` turns off `onScroll`
regardless of bindings.

**Services get restarted without `onConfigChanged`.** Define it, or the whole
top-level chunk re-runs on a settings change and in-memory state is gone. Since
`noctalia.state` survives that restart, key any cache you put there by the
config it depends on.

**`onClose` is a panel lifecycle callback.** Naming a button handler `onClose`
collides with it. Use a distinct name.

**A tree that is never passed to `panel.render()` fails silently.** If you write
a builder that returns the tree and then call it without using the result, the
panel opens empty with no error anywhere. This is the single easiest way to get
an empty surface.

**There may be no log to read.** On a normal session Noctalia's stdout and
stderr point at `/dev/null`, and there is no log file by default. `noctalia msg
log-level-set` controls the console level, which is still `/dev/null`. Unknown
control types and props are logged and skipped rather than fatal, so a typo
shows up only in a log you cannot see. Build your own feedback channel when
debugging, see [Debugging](#debugging).

**`ui.image` loads local files only.** Download remote previews with
`noctalia.download()` first.

**`require` is relative and single-return.** See
[Modules with require](#modules-with-require).

**Panel size is host-owned.** Declare it in the manifest. There is no setSize.

## Local development loop

Drop the plugin at `~/.local/share/noctalia/plugins/<plugin>/` and it is
discovered as the built-in `local` source.

```sh
noctalia msg plugins list                 # confirm it is seen; [local] tag
noctalia msg plugins enable me/hello      # installed is not the same as enabled
```

For a checkout elsewhere, add a path source instead:

```sh
noctalia msg plugins source add dev path ~/dev/community-plugins
noctalia msg plugins enable dev/hello
```

`.luau` edits hot-reload on their own. Manifest changes need a config reload
(`noctalia msg config-reload`). If a change does not seem to take effect, a full
`plugins disable` then `enable` is deterministic.

Test entries over IPC:

```sh
noctalia msg panel-toggle me/hello:inbox
noctalia msg plugin me/hello:hello focused say "hi"    # bar widget, per output
noctalia msg plugin me/hello:ticker all refresh        # service and panels: `all`
```

Bar widgets take an output selector (`focused`, a connector, or `all`). Entries
with no output, such as services and panels, only match `all`.

### Editor setup

`noctalia.d.luau` declares the whole plugin API, so luau-lsp gives you
autocomplete and typo diagnostics. It lives in `official-plugins` as the single
source of truth and is not vendored, so fetch it:

```sh
curl -O https://raw.githubusercontent.com/noctalia-dev/official-plugins/main/noctalia.d.luau
```

Point luau-lsp at it through `types.definitionFiles`. Re-fetch when the API
changes; your copy is a snapshot. Commit a `.luaurc` with
`"languageMode": "nonstrict"` to match the `--!nonstrict` directive.

The entry callbacks (`onClick`, `onOpen`, and the rest) are deliberately not
declared in that file, because declaring them would make luau-lsp treat your
definition as overwriting a built-in.

## Debugging

Work outside in. Each step either finds the fault or rules out a whole layer.

1. **Syntax.** Luau's `+=` and `--!nonstrict` are not valid Lua, so a Lua parser
   gives false errors. Use the real thing:

   ```sh
   luau-compile widget.luau     # exits non-zero and prints the error
   ```

   Grab a static binary from the `luau-lang/luau` releases if you do not have it.

2. **Manifest and settings.** Cross-checks declared settings against plugin code,
   and checks that the declared `plugin_api` covers the features you use (for
   example `[widget.actions]` needs 14):

   ```sh
   noctalia plugins lint .
   ```

3. **Config.** Validates the merged TOML config, and flags unknown widget types
   and settings:

   ```sh
   noctalia config validate
   ```

4. **Is the entry live at all?** Dispatch to it and read the answer:

   ```sh
   noctalia msg plugin me/hello:inbox all probe
   ```

   `ok: dispatched 1` means the entry is loaded. The reply
   `error: matched plugin entry has no onIpc callback` also proves the entry was
   matched, which is just as useful. Use this to separate "the script failed to
   load" from "the script loaded and renders nothing".

5. **No logs? Render into the surface.** This is the reliable channel:

   ```lua
   function onOpen(_context)
     noctalia.notify("hello diagnostic", "onOpen fired")
     local ok, treeOrError = pcall(buildTree)
     if ok then
       panel.render(treeOrError)
     else
       panel.render(ui.column({ flexGrow = 1, gap = 8 }, {
         ui.label({ text = "BUILD ERROR", fontWeight = "bold", color = "primary" }),
         ui.label({ text = tostring(treeOrError), fontSize = 13 }),
       }))
     end
   end
   ```

   Run the same `pcall` around `require` and around any `noctalia.*` call you
   suspect, and draw the result. A notification is a second, independent
   channel.

6. **Look at it.** On niri:

   ```sh
   niri msg action screenshot-screen     # writes to ~/Pictures/Screenshots/
   ```

   Crop the surface region and read it. Diffing an open shot against a
   `noctalia msg panel-close` baseline locates the surface, but the diff is
   noisy: the bar animates (audio visualizer, CPU and RAM graphs, clock) and
   your own terminal output changes between shots. Ignore rows above the bar
   when locating the surface.

7. **Check API names against the definitions.** `luau-analyze` cannot parse
   `declare` in a normal file, so it will not typecheck against
   `noctalia.d.luau`. Grep the definitions instead:

   ```sh
   grep -n "setGlyphColor\|UiLabelProps" noctalia.d.luau
   ```

   The `export type Ui*Props` blocks are the authoritative prop lists and
   enums, including which props are gated on an API level.

### Empty surface checklist

In rough order of likelihood:

1. `panel.render()` is never called, or its return value is discarded.
2. `onOpen` is not defined, or it is defined after a top-level statement that
   threw.
3. The entry failed to load: `require` error, syntax error, or a bad global.
4. The tree built but the root has no size, so the surface clips it. Give the
   root `flexGrow = 1`.
5. The props are right but the colors resolve to the background color.

## Publishing

### Your own source repo

A source repo holds many plugins, one per top-level directory. Add it with:

```sh
noctalia msg plugins source add me git https://github.com/me/noctalia-plugins
```

The built-in `official` and `community` sources are git sources of this shape,
and a `path` source points at a plain directory for local work.

A source repo needs a `catalog.toml` at its root so a host can list and
compatibility-check plugins without a full clone:

```toml
[[plugin]]
id           = "me/hello"
name         = "Hello"
version      = "2.0.0"
author       = "me"
license      = "MIT"
icon         = "puzzle"
description  = "A friendly greeter."
deprecated   = false
plugin_api   = 9
tags         = ["demo"]
dependencies = ["slurp"]

[[plugin.release]]
plugin_api = 3
version    = "1.4.0"
rev        = "5082ed5f85e795513b8485e4cedc66d5a2c816ff"
```

Catalog rows need `id`, `name`, and a positive integer `plugin_api`; rows missing
any of those are ignored. The per-plugin `plugin.toml` stays authoritative and
the host re-reads it on enable.

`[[plugin.release]]` rows are how a plugin that raised its `plugin_api` stays
installable on older shells. Each row names an older revision for a lower level,
newest first, and needs `plugin_api`, `version`, and a full 40-character `rev`.
A host picks the newest release its own range allows and exports that exact
commit, so an older user gets the older version instead of nothing. Rows at or
above the tip's level are dropped, and release rows apply to `git` sources only,
because a `path` source has no revisions to export.

The `update-catalog.py` script in the official and community repos generates
these rows by walking `git log -- <subdir>/plugin.toml` newest-first and keeping
each revision that lowers the level. It needs full history, so CI sets
`fetch-depth: 0`.

### The community store

Community plugins go to `github.com/noctalia-dev/community-plugins` as a PR.
Plugins maintained by the core team live in `official-plugins`, which does not
accept third-party submissions.

Layout rules: one top-level directory per plugin, named after the part of the id
after the `/`. Both id segments must be lowercase. The directory name is
first-come within the repo.

Required files, enforced by CI: `README.md`, `thumbnail.webp` (960x540, generate
it with the thumbnail generator on assets.noctalia.dev), and
`translations/en.json`. `catalog.toml` at the repo root is generated by CI, so
never edit it or commit it.

`tags` must come from the fixed list in the repo README (surfaces, purpose,
compositors, distros). Propose a new tag in your PR rather than inventing one.

README requirements: document every entry id exactly as it appears in the
manifest, include the exact `noctalia msg panel-toggle <author>/<plugin>:<id>`
command if you ship a panel, document the `/<prefix>` and an example query if
you ship a launcher provider, and mention every manifest dependency by name
under a non-empty `## Requirements` section. CI derives the ids, commands,
prefixes, dependencies, and whether settings exist from `plugin.toml` and fails
on a mismatch.

Review rules, from the community repo README:

- No obfuscated, minified, or generated code. A reviewer must be able to read
  every line.
- No downloading and executing remote code. Ship your logic in the repo at a
  version people reviewed.
- Declare every external command in `dependencies` and mention it in the README.
- Account for every network call, filesystem write, and spawned process in the
  PR description.

The plugin system is in beta, so the manifest format and the plugin API can
still change before v5 is stable.

## Minimal plugin template

```
hello/
  plugin.toml
  hello.luau
  translations/en.json
```

```toml
id          = "me/hello"
name        = "Hello"
version     = "0.1.0"
plugin_api  = 14         # 14 is for [widget.actions] below; drop to 3 without it
author      = "me"
license     = "MIT"
icon        = "mail"
description = "Shows a counter in the bar."
tags        = ["demo", "bar"]

[[widget]]
id    = "hello"
entry = "hello.luau"

  [widget.actions]
  middle = "none"     # free the middle button for onMiddleClick
```

```lua
--!nonstrict
local count = 0

noctalia.setUpdateInterval(1000)

local function render()
  barWidget.setGlyph("mail")
  barWidget.setText(noctalia.tr("title") .. " " .. count)
end

render()

function update()
  count += 1
  render()
end

function onClick()
  noctalia.notify(noctalia.tr("title"), string.format("%d", count))
end

function onMiddleClick()
  count = 0
  render()
end
```

```json
{
  "title": "Hello"
}
```

```sh
mkdir -p ~/.local/share/noctalia/plugins/hello
# copy the files in, then:
noctalia plugins lint ~/.local/share/noctalia/plugins/hello
noctalia msg plugins enable me/hello
```

Add the widget to a bar afterwards. A plugin widget is a named instance on the
bar, and the instance points at the entry with the fully qualified type:

```toml
[widget.hello]
type = "me/hello:hello"

[bar.default]
end = ["hello"]
```

The `[bar.*]` and `[widget.*]` values may live in
`~/.local/state/noctalia/settings.toml` instead, because GUI-managed overrides
there win over `~/.config/noctalia/*.toml`. Check that file when a hand-written
bar setting appears to be ignored.
