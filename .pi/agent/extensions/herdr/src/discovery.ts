import { UnixHerdrClient } from "./client.ts";
import type { HerdrContext, RequestOptions } from "./types.ts";

export const MINIMUM_HERDR_PROTOCOL = 16;

export function hasHerdrMarkers(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV !== undefined || env.HERDR_SOCKET_PATH !== undefined || env.HERDR_PANE_ID !== undefined;
}

export async function discoverHerdr(
  env: NodeJS.ProcessEnv = process.env,
  options: RequestOptions = {},
): Promise<HerdrContext | undefined> {
  if (!hasHerdrMarkers(env)) return undefined;
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) {
    const error = new Error("Incomplete Herdr environment: HERDR_ENV=1, HERDR_SOCKET_PATH, and HERDR_PANE_ID are required");
    error.name = "HerdrDiscoveryError";
    (error as any).code = "ERR_HERDR_ENV";
    throw error;
  }

  const client = new UnixHerdrClient(env.HERDR_SOCKET_PATH);
  const [{ version, protocol }, pane] = await Promise.all([
    client.ping(options),
    client.getPane(env.HERDR_PANE_ID, options),
  ]);
  if (protocol < MINIMUM_HERDR_PROTOCOL) {
    const error = new Error(`Herdr protocol ${protocol} is too old; protocol ${MINIMUM_HERDR_PROTOCOL} or newer is required`);
    error.name = "HerdrDiscoveryError";
    (error as any).code = "ERR_HERDR_PROTOCOL";
    throw error;
  }

  return {
    socketPath: env.HERDR_SOCKET_PATH,
    paneId: pane.pane_id,
    tabId: pane.tab_id,
    workspaceId: pane.workspace_id,
    version,
    protocol,
  };
}
