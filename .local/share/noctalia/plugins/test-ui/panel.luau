--!nonstrict
-- Panel entry: the dropdown "table" of messages.
--
-- Opened by clicking the bar widget, or directly:
--   noctalia msg panel-toggle toms/test-ui:inbox
--
-- The panel owns the read/unread state and publishes counts to noctalia.state so
-- the bar widget stays in sync.

local inbox = require("./lib/inbox.luau")

local hoveredId = nil

-- Forward declaration: messageRow's click closure and the hover/reset handlers
-- all re-render through this.
local render

local function summary()
  local new, unread = inbox.counts()
  return string.format(
    "(%d) %s; (%d) %s",
    new, noctalia.tr("counts.new"),
    unread, noctalia.tr("counts.unread")
  )
end

local function publishCounts()
  local new, unread = inbox.counts()
  noctalia.state.set("inbox", { new = new, unread = unread })
end

local function markRead(id)
  for _, message in ipairs(inbox.messages) do
    if message.id == id then
      message.unread = false
      message.isNew = false
      break
    end
  end
  publishCounts()
end

local function headerCell(text, props)
  props = props or {}
  props.text = text
  props.fontSize = 10
  props.fontWeight = "bold"
  props.color = "on_surface/0.5"
  return ui.label(props)
end

local function messageRow(message)
  local props = {
    key = "message-" .. message.id,
    gap = 10,
    paddingH = 8,
    paddingV = 7,
    align = "center",
    radius = 6,
    onClick = function()
      markRead(message.id)
      render()
    end,
    onHover = "onRowHover",
  }
  if hoveredId == message.id then
    props.fill = "surface_variant/0.5"
  end

  -- Unread dot: primary for a new message, muted for the rest. Read rows get an
  -- unfilled box so the column keeps its width.
  local dot = { width = 8, height = 8, radius = 4 }
  if message.isNew then
    dot.fill = "primary"
  elseif message.unread then
    dot.fill = "on_surface/0.35"
  end

  local sender = { text = message.from, width = 148, fontSize = 12, maxLines = 1 }
  if message.unread then
    sender.fontWeight = "bold"
  end

  return ui.row(props, {
    ui.box(dot),
    ui.label(sender),
    ui.label({
      text = message.subject,
      flexGrow = 1,
      fontSize = 12,
      maxLines = 1,
      color = message.unread and "on_surface" or "on_surface/0.55",
    }),
    ui.label({
      text = message.time,
      width = 46,
      fontSize = 11,
      color = "on_surface/0.5",
      textAlign = "end",
    }),
  })
end

render = function()
  local rows = {}
  for _, message in ipairs(inbox.messages) do
    rows[#rows + 1] = messageRow(message)
  end

  panel.render(ui.column({ flexGrow = 1, gap = 12 }, {
    ui.row({ align = "center", gap = 8 }, {
      ui.glyph({ name = "mail", size = 18, color = "primary" }),
      ui.label({ text = noctalia.tr("panel.title"), fontSize = 16, fontWeight = "bold" }),
      ui.label({ text = summary(), fontSize = 11, color = "on_surface/0.6", flexGrow = 1 }),
      ui.button({
        glyph = "refresh",
        glyphSize = 14,
        variant = "ghost",
        tooltip = noctalia.tr("panel.reset"),
        onClick = "onReset",
      }),
      ui.button({
        glyph = "close",
        glyphSize = 14,
        variant = "ghost",
        tooltip = noctalia.tr("panel.close"),
        onClick = "onCloseClicked",
      }),
    }),

    ui.column({ gap = 0 }, {
      ui.row({ gap = 10, paddingH = 8, paddingV = 6 }, {
        ui.label({ text = "", width = 8 }),
        headerCell(noctalia.tr("panel.column.from"), { width = 148 }),
        headerCell(noctalia.tr("panel.column.subject"), { flexGrow = 1 }),
        headerCell(noctalia.tr("panel.column.time"), { width = 46, textAlign = "end" }),
      }),
      ui.separator({ thickness = 1, spacing = 4 }),
    }),

    ui.scroll({ flexGrow = 1, gap = 0 }, rows),
  }))
end

function onOpen(_context)
  render()
end

-- A ui.row with onHover reports enter and leave; it receives the state and the
-- node's key, so one handler serves every row.
function onRowHover(state, key)
  local id = tonumber(string.match(key or "", "^message%-(%d+)$"))
  local nextId = (state == "true") and id or nil
  if nextId ~= hoveredId then
    hoveredId = nextId
    render()
  end
end

function onReset()
  inbox.reset()
  hoveredId = nil
  publishCounts()
  render()
end

function onCloseClicked()
  panel.close()
end

-- Publish the default counts once at load, so the widget's counter is
-- authoritative from the start rather than only after the first click. Kept
-- below the callback definitions on purpose: if this threw, onOpen would never
-- be registered and the panel would open empty.
publishCounts()
