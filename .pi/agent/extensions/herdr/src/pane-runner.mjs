import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error("Missing Herdr job request path");
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const startedAt = new Date().toISOString();
  const output = createWriteStream(request.outputPath, { flags: "a", mode: 0o600 });
  let requestedSignal;
  let child;

  const forward = (signal) => {
    requestedSignal = signal;
    try {
      child?.kill(signal === "SIGHUP" ? "SIGTERM" : signal);
    } catch {
      // The close event owns result finalization.
    }
  };
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, () => forward(signal));

  let launchError;
  try {
    child = spawn("bash", ["-c", request.cmd], {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    launchError = error;
  }

  if (launchError) {
    output.end();
    await new Promise((resolve) => output.once("close", resolve));
    await atomicJson(request.resultPath, {
      exitCode: null,
      signal: null,
      startedAt,
      endedAt: new Date().toISOString(),
      error: {
        code: launchError?.code === "ENOENT" ? "ERR_BASH_NOT_FOUND" : "ERR_BASH_LAUNCH",
        message: launchError instanceof Error ? launchError.message : String(launchError),
      },
    });
    process.exitCode = 127;
    return;
  }

  const append = (chunk, target) => {
    output.write(chunk);
    target.write(chunk);
  };
  child.stdout.on("data", (chunk) => append(chunk, process.stdout));
  child.stderr.on("data", (chunk) => append(chunk, process.stderr));

  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({
      exitCode: null,
      signal: null,
      error: {
        code: error?.code === "ENOENT" ? "ERR_BASH_NOT_FOUND" : "ERR_BASH_LAUNCH",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal: signal ?? requestedSignal ?? null }));
  });

  output.end();
  await new Promise((resolve) => output.once("close", resolve));
  await atomicJson(request.resultPath, {
    ...result,
    startedAt,
    endedAt: new Date().toISOString(),
  });
  process.exitCode = result.exitCode ?? (result.error ? 127 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
