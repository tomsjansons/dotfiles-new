--!nonstrict
-- Bar widget entry: a static email counter.
--
-- Left click toggles the inbox panel. The counts come from the static list in
-- lib/inbox.luau; the panel publishes updated counts to noctalia.state whenever
-- the user marks a message read, and this entry watches that value.
--
--   noctalia msg plugin toms/test-ui:email focused say "hello"
--   noctalia msg panel-toggle toms/test-ui:inbox

local inbox = require("./lib/inbox.luau")

local PANEL_ID = "toms/test-ui:inbox"

-- Last value the panel published, or nil while nothing has published yet.
local published = nil

local function counts()
  if published ~= nil then
    return published.new or 0, published.unread or 0
  end
  return inbox.counts()
end

local function render()
  local new, unread = counts()

  barWidget.setGlyph("mail")
  barWidget.setGlyphColor(new > 0 and "primary" or "on_surface")
  barWidget.setText(string.format(
    "(%d) %s; (%d) %s",
    new, noctalia.tr("counts.new"),
    unread, noctalia.tr("counts.unread")
  ))
  barWidget.setTooltip(noctalia.tr("widget.tooltip"))
end

-- Read once at load in case the panel published before this entry started, then
-- keep up with later changes.
published = noctalia.state.get("inbox")
noctalia.state.watch("inbox", function(value)
  published = value
  render()
end)

render()

function onClick()
  noctalia.togglePanel(PANEL_ID)
end

function onIpc(event, payload)
  if event == "say" then
    noctalia.notify(noctalia.tr("widget.tooltip"), payload or "")
  end
end
