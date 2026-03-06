import { stopBrowserBridgeServer } from "../../browser/bridge-server.js";
export const BROWSER_BRIDGES = new Map();
/**
 * Release the in-memory browser bridge server for a given session.
 * Stops the HTTP proxy server but does NOT remove the Docker container
 * (the container persists for reuse; cleaned up by prune or session deletion).
 *
 * Uses the raw sessionKey as the lookup key, which only matches "session" scope.
 * For "agent" / "shared" scope the bridge is shared and intentionally not released.
 */
export async function releaseSessionBrowserBridge(sessionKey) {
  const bridge = BROWSER_BRIDGES.get(sessionKey);
  if (!bridge) {
    return;
  }
  await stopBrowserBridgeServer(bridge.bridge.server).catch(() => undefined);
  BROWSER_BRIDGES.delete(sessionKey);
}
