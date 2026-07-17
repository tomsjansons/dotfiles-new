import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRunnerRequestJson,
  RUNNER_REQUEST_ERROR_CODE,
  RunnerRequestProtocolError,
  validateRunnerRequest,
  type RunnerRequest,
} from "../src/index.ts";

function validRequest(): RunnerRequest {
  return {
    id: "job-123",
    cmd: "  printf '%s\\n' \"$VALUE\"; $(opaque)\n",
    cwd: "/tmp/work tree",
    outputPath: "/tmp/artifacts/output.log",
    resultPath: "/tmp/artifacts/runner-result.json",
    env: { PATH: "/usr/bin", VALUE: "a=b" },
  };
}

function assertProtocolError(run: () => unknown, field: string, message: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RunnerRequestProtocolError);
    assert.equal(error.name, "RunnerRequestProtocolError");
    assert.equal(error.code, RUNNER_REQUEST_ERROR_CODE);
    assert.equal(error.field, field);
    assert.equal(error.message, `Invalid Herdr runner request: ${field} ${message}`);
    return true;
  });
}

test("runner protocol accepts its exported type without interpreting cmd", () => {
  const request = validRequest();
  const validated = validateRunnerRequest(request);

  assert.notStrictEqual(validated, request);
  assert.deepEqual(validated, request);
  assert.equal(validated.cmd, "  printf '%s\\n' \"$VALUE\"; $(opaque)\n");
  assert.deepEqual(parseRunnerRequestJson(JSON.stringify(request)), request);
});

test("runner protocol rejects malformed fields with stable diagnostics", () => {
  const cases: Array<{
    field: string;
    message: string;
    value: unknown;
  }> = [
    { field: "request", message: "must be an object", value: null },
    { field: "id", message: "must not be empty", value: { ...validRequest(), id: "" } },
    { field: "cmd", message: "must be a string", value: { ...validRequest(), cmd: 42 } },
    { field: "cwd", message: "must be an absolute path", value: { ...validRequest(), cwd: "relative" } },
    { field: "outputPath", message: "must not contain NUL", value: { ...validRequest(), outputPath: "/tmp/out\0log" } },
    { field: "resultPath", message: "must differ from outputPath", value: { ...validRequest(), resultPath: validRequest().outputPath } },
    { field: "env", message: "must be an object of string values", value: { ...validRequest(), env: null } },
    { field: "env", message: "must contain only string values", value: { ...validRequest(), env: { COUNT: 1 } } },
    { field: "env", message: "contains an invalid variable name", value: { ...validRequest(), env: { "BAD=NAME": "value" } } },
    { field: "extra", message: "is not supported", value: { ...validRequest(), extra: true } },
  ];

  for (const fixture of cases) {
    assertProtocolError(() => validateRunnerRequest(fixture.value), fixture.field, fixture.message);
  }

  assertProtocolError(() => parseRunnerRequestJson("{"), "request", "must be valid JSON");
});
