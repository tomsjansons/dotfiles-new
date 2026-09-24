--!nonstrict
-- Static inbox contents for the test-ui plugin.
--
-- There is no mail integration here. The messages below are fixed test data so
-- the bar widget and the panel have something consistent to render.
--
-- SOURCE stays immutable and `M.messages` is the working copy, which lets the
-- panel's reset button restore the default state without reloading the entry.
-- Read the working copy through `inbox.messages` at render time rather than
-- caching it, because M.reset() replaces the table.

local SOURCE = {
  { id = 1, from = "Ana Ruiz", subject = "Q3 roadmap: final sign-off needed", time = "09:12", unread = true, isNew = true },
  { id = 2, from = "GitHub", subject = "[noctalia] PR #482 ready for review", time = "08:58", unread = true },
  { id = 3, from = "Stripe", subject = "Payout of EUR 4,120.00 is on the way", time = "08:40", unread = true },
  { id = 4, from = "Marcin Kowalski", subject = "Re: staging DB migration window", time = "08:21", unread = true },
  { id = 5, from = "Vercel", subject = "Deployment failed: web-prod", time = "08:03", unread = true },
  { id = 6, from = "Lena Fischer", subject = "Design handoff for the inbox panel", time = "07:47", unread = true },
  { id = 7, from = "AWS Billing", subject = "Your invoice for April is available", time = "07:30", unread = true },
  { id = 8, from = "Priya Nair", subject = "Interview debrief: backend candidate", time = "07:12", unread = true },
  { id = 9, from = "Grafana Alerts", subject = "Firing: api-latency-p99 above 800ms", time = "06:55", unread = true },
  { id = 10, from = "Noctalia CI", subject = "Nightly build 4821 passed", time = "06:32", unread = true },
  { id = 11, from = "Daniel Okafor", subject = "Contract renewal, need your signature", time = "06:10", unread = true },
  { id = 12, from = "Figma", subject = "Lena commented on Bar widget", time = "05:51", unread = true },
  { id = 13, from = "Sofia Marchetti", subject = "Invoice #2291 attached", time = "05:33", unread = true },
  { id = 14, from = "GitHub Actions", subject = "Workflow run failed on main", time = "05:12", unread = true },
  { id = 15, from = "Cloudflare", subject = "Weekly security digest", time = "04:58", unread = true },
  { id = 16, from = "Jonas Berg", subject = "Re: NixOS module for the plugin source", time = "04:40", unread = true },
  { id = 17, from = "Hetzner", subject = "Server maintenance on 2025-06-14", time = "04:22", unread = true },
  { id = 18, from = "Amara Diallo", subject = "Budget review moved to Thursday", time = "04:05", unread = true },
  { id = 19, from = "Sentry", subject = "New issue: TypeError in renderTree", time = "03:47", unread = true },
  { id = 20, from = "Linus Vogt", subject = "Re: bar widget spacing on vertical bars", time = "03:29", unread = true },
  { id = 21, from = "npm", subject = "Security advisory for a dependency", time = "03:11", unread = true },
  { id = 22, from = "Rachel Green", subject = "Onboarding docs, first draft", time = "02:54", unread = true },
  { id = 23, from = "PagerDuty", subject = "Resolved: db-replica lag", time = "02:36", unread = true },
  { id = 24, from = "Kofi Mensah", subject = "Follow-up from yesterday's sync", time = "02:18", unread = true },
  { id = 25, from = "DigitalOcean", subject = "Droplet snapshot completed", time = "02:01", unread = true },
  { id = 26, from = "Yuki Tanaka", subject = "Localization PR for ja.json", time = "01:43", unread = true },
  { id = 27, from = "Buildkite", subject = "Pipeline #9923 queued for 12 minutes", time = "01:25", unread = true },
  { id = 28, from = "Elena Petrova", subject = "Re: plugin catalog review feedback", time = "01:07", unread = true },
  { id = 29, from = "Home Assistant", subject = "Front door unlocked at 23:41", time = "00:49", unread = true },
  { id = 30, from = "Mehdi Ahmadi", subject = "Re: Luau require() hot reload", time = "00:31", unread = true },
  { id = 31, from = "GitHub", subject = "Security alert: 1 Dependabot alert", time = "00:14", unread = true },
  { id = 32, from = "Nils Andersen", subject = "Weekend hack: declarative graph widget", time = "23:56", unread = true },
  { id = 33, from = "Opsgenie", subject = "On-call handoff summary", time = "23:38", unread = true },
  { id = 34, from = "Anna Lindqvist", subject = "Meeting notes: shell theming", time = "22:40", unread = false },
  { id = 35, from = "GitHub", subject = "[noctalia] Issue #471 closed", time = "21:15", unread = false },
  { id = 36, from = "Marcus Weber", subject = "Re: plugin API v31 timeline", time = "19:52", unread = false },
  { id = 37, from = "Spotify", subject = "Your Wrapped is ready", time = "18:07", unread = false },
  { id = 38, from = "Carmen Silva", subject = "Thanks for the review!", time = "16:33", unread = false },
}

local function copySource()
  local messages = {}
  for index, message in ipairs(SOURCE) do
    messages[index] = {
      id = message.id,
      from = message.from,
      subject = message.subject,
      time = message.time,
      unread = message.unread,
      isNew = message.isNew or false,
    }
  end
  return messages
end

local M = {}

-- Working copy. Always read it fresh: M.reset() replaces this table.
M.messages = copySource()

function M.counts()
  local new, unread = 0, 0
  for _, message in ipairs(M.messages) do
    if message.unread then
      unread += 1
    end
    if message.isNew then
      new += 1
    end
  end
  return new, unread
end

function M.reset()
  M.messages = copySource()
end

return M
