# Pi jobs

Step-one unified managed-job extension.

## Model tools

- `job({ type: "js", cmd, mode?, timeout? })`
- `job_list({ type?, include?, cursor? })`
- `job_stop({ id })`

The same three functions are available inside JavaScript jobs. Nested jobs are supported. Only asynchronous root jobs send completion messages; nested jobs remain silent unless their parent returns their metadata or output path.

JavaScript jobs:

- output only through `return` (`console` throws guidance);
- persist full SuperJSON/YAML output under `~/.pi/pi-execute/`;
- return a 2,000-line/50-KiB head-and-tail projection;
- allow unrestricted filesystem/network access, dynamic `import()`, and `fetch`;
- deny direct subprocesses, workers, native addons, FFI/WASI, and inspector access;
- use `job({ type: "bash" })` for subprocess work once the step-two provider is installed.

There are no job read/wait operations. Use normal Pi `read` outside JavaScript, `node:fs/promises` inside JavaScript, and ordinary Promise timers with `job_list` for waiting.

The routed local/Herdr `bash` provider is step two and is not implemented in this package yet.
