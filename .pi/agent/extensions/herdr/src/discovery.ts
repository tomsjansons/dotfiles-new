import { UnixHerdrClient } from "./client.ts";
import type { HerdrContext, HerdrServerCapabilities, RequestOptions } from "./types.ts";

export const MINIMUM_HERDR_PROTOCOL = 16;

function discoveryError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = "HerdrDiscoveryError";
  error.code = code;
  return error;
}

function validateCapabilities(value: unknown): HerdrServerCapabilities {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw discoveryError("ERR_HERDR_CAPABILITIES", "Herdr ping returned missing or invalid capability metadata");
  }

  const metadata = value as Record<string, unknown>;
  if (typeof metadata.live_handoff !== "boolean" || typeof metadata.detached_server_daemon !== "boolean") {
    throw discoveryError("ERR_HERDR_CAPABILITIES", "Herdr ping returned missing or invalid capability metadata");
  }

  const capabilities: HerdrServerCapabilities = {
    live_handoff: metadata.live_handoff,
    detached_server_daemon: metadata.detached_server_daemon,
  };
  // Managed job panes must remain server-owned when the terminal UI detaches.
  if (!capabilities.detached_server_daemon) {
    throw discoveryError(
      "ERR_HERDR_CAPABILITIES",
      "Herdr capability detached_server_daemon is required for managed pane jobs",
    );
  }
  return capabilities;
}

export function hasHerdrMarkers(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV !== undefined || env.HERDR_SOCKET_PATH !== undefined || env.HERDR_PANE_ID !== undefined;
}

export async function discoverHerdr(
  env: NodeJS.ProcessEnv = process.env,
  options: RequestOptions = {},
): Promise<HerdrContext | undefined> {
  if (!hasHerdrMarkers(env)) return undefined;
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) {
    throw discoveryError(
      "ERR_HERDR_ENV",
      "Incomplete Herdr environment: HERDR_ENV=1, HERDR_SOCKET_PATH, and HERDR_PANE_ID are required",
    );
  }

  const client = new UnixHerdrClient(env.HERDR_SOCKET_PATH);
  const [{ version, protocol, capabilities: capabilityMetadata }, pane] = await Promise.all([
    client.ping(options),
    client.getPane(env.HERDR_PANE_ID, options),
  ]);
  if (protocol < MINIMUM_HERDR_PROTOCOL) {
    throw discoveryError(
      "ERR_HERDR_PROTOCOL",
      `Herdr protocol ${protocol} is too old; protocol ${MINIMUM_HERDR_PROTOCOL} or newer is required`,
    );
  }
  const capabilities = validateCapabilities(capabilityMetadata);

  return {
    socketPath: env.HERDR_SOCKET_PATH,
    paneId: pane.pane_id,
    tabId: pane.tab_id,
    workspaceId: pane.workspace_id,
    version,
    protocol,
    capabilities,
  };
}
