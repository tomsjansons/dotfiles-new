# Design the hidden `agent` job-type integration

Type: grilling
Status: open
Blocked by: 02, 03, 09

## Question

How should the required `agent` job type fit into `job-runtime`, `pi-jobs`, and the isolated JavaScript RPC surface so that agent jobs reuse lineage, persistence, artifact, cancellation, recovery, and provider abstractions while remaining launchable, listable, and stoppable only from JavaScript? Define the capability/visibility seam so model-facing exposure can be added later without redesigning the runtime.
