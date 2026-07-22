# Design Herdr and local launch routing

Type: grilling
Status: open
Blocked by: 02, 04

## Question

What exact provider and resource-ownership design should launch each agent job in an independent Herdr `pi-shell` pane, safely create or reuse the tab and anchor when needed, and otherwise launch a local headless Pi process? Resolve pane allocation, labels, focus, terminal/process I/O, control-channel transport, no-fallback-after-Herdr-allocation behavior, and the metadata each mode reports.
