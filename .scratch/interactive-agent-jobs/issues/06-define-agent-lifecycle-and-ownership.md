# Define agent lifecycle and ownership

Type: grilling
Status: open
Blocked by: 04, 05

## Question

What lifecycle state machine and ownership rules govern an agent job from allocation through kickoff, interaction, idle completion, result delivery, post-result retention or shutdown, explicit stop, timeout, parent-job termination, host-session shutdown, process/pane failure, and crash recovery? Include nested JavaScript and recursively spawned-agent scenarios and specify how cleanup remains idempotent under races.
