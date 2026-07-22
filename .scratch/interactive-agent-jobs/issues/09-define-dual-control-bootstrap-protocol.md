# Define the dual-control bootstrap protocol and input arbitration

Type: grilling
Status: open
Assignee: toms
Blocked by: 02

## Question

What exact bootstrap state machine, authenticated Unix-socket protocol, and `InteractiveMode` control seam should turn the proven prototype into a deterministic supported design? Define readiness, one-shot kickoff acceptance, authoritative result delivery, duplicate and late messages, controller disconnect, cancellation and shutdown; specify how startup-gap input, streaming steering, queued follow-up, completion-boundary input, and built-in session replacement are classified; and identify the smallest public Pi API needed to avoid the prototype's private `pendingUserInputs` and `shutdown()` access while preserving a normal retained TUI.
