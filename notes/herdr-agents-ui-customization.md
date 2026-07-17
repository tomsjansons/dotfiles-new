# Herdr Agents UI customization

Research date: 2026-07-16  
Stable release checked: Herdr v0.7.4 (2026-07-15)

## Bottom line

The expanded desktop Agents section is configurable through `config.toml`: its sort mode, row spacing, displayed fields, field order, and complete layouts for known canonical agent types can be changed. Scripts and plugins can supply dynamic metadata values for configured `$name` fields.

Herdr does not currently expose arbitrary agent groups, manual ordering, per-agent filtering/hiding, or a plugin extension point for injecting controls/widgets into the native Agents section. A plugin can instead render a separate custom dashboard in a terminal pane or popup.

## Supported controls

- `ui.agent_panel_sort = "spaces" | "priority"`
  - `spaces` is the default grouped-by-space/workspace ordering.
  - `priority` is Herdr's built-in attention ordering.
  - The former workspace/all scope filter was removed in v0.7.1; all agents are shown.
- `ui.sidebar.agents.row_gap` controls blank rows between entries.
- `ui.sidebar.agents.rows` controls expanded Agent entry lines and token order.
- `ui.sidebar.agents.rows_by_agent` completely replaces the default layout for canonical IDs such as `pi`, `claude`, and `codex`.
- Available stable v0.7.4 Agent row tokens:
  - `state_icon`, `state_text`
  - `workspace`, `tab`, `pane`
  - `agent`
  - `terminal_title`, `terminal_title_stripped`
  - custom pane metadata tokens such as `$model` and `$summary`
- A layout may contain at most 16 rows and 16 tokens per row.
- Missing values and separators disappear; a row disappears when all its values are missing.
- Row configuration affects only the expanded desktop sidebar. Collapsed/mobile layouts remain compact and fixed.
- Display names can be changed with `herdr agent rename` or display metadata.
- Custom labels for semantic states can be reported with `herdr pane report-metadata --state-label ...` and displayed through `state_text`.
- Width, min/max width, collapsed mode, sidebar toggle, and agent navigation keybindings are separately configurable.

Example:

```toml
[ui]
agent_panel_sort = "priority"
sidebar_width = 32

[ui.sidebar.agents]
row_gap = 1
rows = [
  ["state_icon", "state_text", "agent"],
  ["$model", "$summary"],
  ["workspace", "tab", "pane"],
]

[ui.sidebar.agents.rows_by_agent]
pi = [
  ["state_icon", "agent", "state_text"],
  ["terminal_title_stripped"],
  ["$model", "workspace", "tab"],
]
```

Supply dynamic values from a hook, script, or plugin:

```bash
herdr pane report-metadata "$HERDR_PANE_ID" \
  --source my-agent-hook \
  --token model=gpt-5.5 \
  --token summary="reviewing authentication"
```

## Config versus plugins

| Capability | Config | Plugin/script |
|---|---:|---:|
| Choose fields and order | Yes | No; supplies values only |
| Per-known-agent layout | Yes | No runtime layout selection |
| Dynamic custom fields | Declare `$name` token | Report token value through CLI/socket |
| Row spacing | Yes | No |
| Spaces/priority sorting | Yes | No documented custom comparator |
| Rename display identity | CLI/config-adjacent | Can call CLI |
| Custom semantic state/labels | Layout chooses display | Can report state and labels |
| Arbitrary groups/manual order | No | No native-panel API |
| Hide/filter agents | No | No native-panel API |
| Native controls/widgets | No | Not supported by plugin v1 |
| Separate custom dashboard | Keybinding optional | Yes: popup/overlay/split/tab/zoomed pane |

Plugins are ordinary executable commands with access to the full Herdr CLI/socket API. They can query agents and panes, report metadata, and open terminal UIs. Plugin v1 explicitly does not provide native non-terminal UI or runtime UI/action registration, so a plugin cannot replace or patch the built-in Agents section through a supported API.

## Version caveat

Current master at `9c9490d764d306b6cc093b5b3de1ccd4e6467c94` additionally documents per-token style tables (`fg`, `bold`, `dim`). The deployed stable docs fetched during this research and the v0.7.4 source docs do not contain that section. Treat token styling as newer/unreleased behavior and verify against the installed binary (`herdr --version` and `herdr --default-config`) before using it.

## First-party sources

- [Configuration: UI and sidebar](https://herdr.dev/docs/configuration/#ui-and-sidebar)
- [Config reference: UI and sidebar](https://herdr.dev/docs/config-reference/#ui-and-sidebar)
- [Agents: custom labels and status](https://herdr.dev/docs/agents/)
- [CLI reference: pane metadata and agent commands](https://herdr.dev/docs/cli-reference/#panes)
- [Plugins](https://herdr.dev/docs/plugins/)
- [v0.7.1 changelog: workspace/all filter removed](https://github.com/ogulcancelik/herdr/blob/v0.7.1/CHANGELOG.md#L5-L16)
- [v0.7.4 changelog: configurable rows and metadata](https://github.com/ogulcancelik/herdr/blob/v0.7.4/CHANGELOG.md#L5-L15)
- [Plugin v1 native UI limitation at inspected source SHA](https://github.com/ogulcancelik/herdr/blob/9c9490d764d306b6cc093b5b3de1ccd4e6467c94/docs/next/website/src/content/docs/plugins.mdx#L24-L34)
- [Master docs for newer inline token styling](https://github.com/ogulcancelik/herdr/blob/9c9490d764d306b6cc093b5b3de1ccd4e6467c94/docs/next/website/src/content/docs/configuration.mdx#L302-L355)
