export interface RunnerRequest {
  id: string;
  cmd: string;
  cwd: string;
  outputPath: string;
  resultPath: string;
  env: Record<string, string>;
}

export const RUNNER_REQUEST_ERROR_CODE: "ERR_HERDR_RUNNER_REQUEST_INVALID";

export class RunnerRequestProtocolError extends Error {
  readonly code: typeof RUNNER_REQUEST_ERROR_CODE;
  readonly field: string;
  constructor(field: string, requirement: string);
}

export function validateRunnerRequest(value: unknown): RunnerRequest;
export function parseRunnerRequestJson(text: string): RunnerRequest;
