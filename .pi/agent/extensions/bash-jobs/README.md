# Bash jobs

Registers the `bash` provider for the shared `job` runtime.

For every launch it validates the current Herdr context. Valid Herdr sessions run in a fresh, unfocused pane split from the reserved anchor in the exact `pi-shell` tab. Outside Herdr—or when inherited Herdr markers fail validation before launch—it runs a managed local process. Once pane allocation begins, Herdr failures never retry locally.

Both backends explicitly execute `bash -c`, retain complete combined output in `output.log`, treat nonzero exits as failed job records, and support sync, async, timeout, process-tree stop, nested jobs, and root-only completion delivery.
