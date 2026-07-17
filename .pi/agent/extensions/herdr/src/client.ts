import { createConnection } from "node:net";

import type { CreatedTab, HerdrClient, HerdrPane, HerdrPing, HerdrTab, RequestOptions } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export class HerdrRequestError extends Error {
  readonly code: string;
  readonly serverCode?: string;

  constructor(code: string, message: string, serverCode?: string) {
    super(message);
    this.name = "HerdrRequestError";
    this.code = code;
    this.serverCode = serverCode;
  }
}

export class UnixHerdrClient implements HerdrClient {
  readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async ping(options?: RequestOptions): Promise<HerdrPing> {
    const result = await this.#request("ping", {}, options);
    this.#expectType(result, "pong");
    if (typeof result.version !== "string" || typeof result.protocol !== "number") {
      throw new HerdrRequestError("ERR_HERDR_RESPONSE", "Herdr ping returned invalid version metadata");
    }
    return { version: result.version, protocol: result.protocol, capabilities: result.capabilities };
  }

  async getPane(paneId: string, options?: RequestOptions): Promise<HerdrPane> {
    const result = await this.#request("pane.get", { pane_id: paneId }, options);
    this.#expectType(result, "pane_info");
    return result.pane as HerdrPane;
  }

  async listTabs(workspaceId: string, options?: RequestOptions): Promise<HerdrTab[]> {
    const result = await this.#request("tab.list", { workspace_id: workspaceId }, options);
    this.#expectType(result, "tab_list");
    return result.tabs as HerdrTab[];
  }

  async listPanes(workspaceId: string, options?: RequestOptions): Promise<HerdrPane[]> {
    const result = await this.#request("pane.list", { workspace_id: workspaceId }, options);
    this.#expectType(result, "pane_list");
    return result.panes as HerdrPane[];
  }

  async createTab(
    input: { workspaceId: string; cwd: string; label: string; focus: boolean },
    options?: RequestOptions,
  ): Promise<CreatedTab> {
    const result = await this.#request(
      "tab.create",
      { workspace_id: input.workspaceId, cwd: input.cwd, label: input.label, focus: input.focus, env: {} },
      options,
    );
    this.#expectType(result, "tab_created");
    return { tab: result.tab as HerdrTab, rootPane: result.root_pane as HerdrPane };
  }

  async splitPane(
    input: { workspaceId: string; targetPaneId: string; direction: "right" | "down"; ratio: number; cwd: string; focus: boolean },
    options?: RequestOptions,
  ): Promise<HerdrPane> {
    const result = await this.#request(
      "pane.split",
      {
        workspace_id: input.workspaceId,
        target_pane_id: input.targetPaneId,
        direction: input.direction,
        ratio: input.ratio,
        cwd: input.cwd,
        focus: input.focus,
        env: {},
      },
      options,
    );
    this.#expectType(result, "pane_info");
    return result.pane as HerdrPane;
  }

  async renamePane(paneId: string, label: string, options?: RequestOptions): Promise<void> {
    const result = await this.#request("pane.rename", { pane_id: paneId, label }, options);
    this.#expectType(result, "pane_info");
  }

  async sendInput(paneId: string, text: string, options?: RequestOptions): Promise<void> {
    const result = await this.#request("pane.send_input", { pane_id: paneId, text, keys: ["Enter"] }, options);
    this.#expectType(result, "ok");
  }

  async closePane(paneId: string, options?: RequestOptions): Promise<void> {
    try {
      const result = await this.#request("pane.close", { pane_id: paneId }, options);
      this.#expectType(result, "ok");
    } catch (error) {
      if (error instanceof HerdrRequestError && error.serverCode === "pane_not_found") return;
      throw error;
    }
  }

  #expectType(result: Record<string, any>, expected: string): void {
    if (result?.type !== expected) {
      throw new HerdrRequestError("ERR_HERDR_RESPONSE", `Expected Herdr result ${expected}, received ${String(result?.type)}`);
    }
  }

  async #request(method: string, params: Record<string, unknown>, options: RequestOptions = {}): Promise<Record<string, any>> {
    const id = `pi-jobs:${crypto.randomUUID()}`;
    const request = `${JSON.stringify({ id, method, params })}\n`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = Buffer.alloc(0);
      let done = false;
      const finish = (error?: unknown, value?: Record<string, any>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve(value!);
      };
      const onAbort = () => finish(new HerdrRequestError("ERR_HERDR_ABORTED", `Herdr request ${method} was aborted`));
      const timer = setTimeout(
        () => finish(new HerdrRequestError("ERR_HERDR_TIMEOUT", `Herdr request ${method} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      socket.once("connect", () => socket.write(request));
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        if (buffer.length > MAX_RESPONSE_BYTES) {
          finish(new HerdrRequestError("ERR_HERDR_RESPONSE_TOO_LARGE", "Herdr response exceeded 10 MiB"));
          return;
        }
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        let response: any;
        try {
          response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        } catch (error) {
          finish(new HerdrRequestError("ERR_HERDR_JSON", `Malformed Herdr response: ${String(error)}`));
          return;
        }
        if (response?.id !== id) {
          finish(new HerdrRequestError("ERR_HERDR_RESPONSE_ID", `Herdr response ID did not match request ${id}`));
          return;
        }
        if (response.error) {
          finish(
            new HerdrRequestError(
              "ERR_HERDR_SERVER",
              `Herdr ${method} failed: ${String(response.error.message ?? response.error.code)}`,
              String(response.error.code ?? "unknown"),
            ),
          );
          return;
        }
        if (!response.result || typeof response.result !== "object") {
          finish(new HerdrRequestError("ERR_HERDR_RESPONSE", `Herdr ${method} response had no result`));
          return;
        }
        finish(undefined, response.result);
      });
      socket.once("error", (error) => finish(new HerdrRequestError("ERR_HERDR_TRANSPORT", error.message)));
      socket.once("end", () => {
        if (!done) finish(new HerdrRequestError("ERR_HERDR_EMPTY_RESPONSE", `Herdr closed ${method} without a response`));
      });
    });
  }
}
