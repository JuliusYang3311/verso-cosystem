import { ProxyAgent, fetch as undiciFetch } from "undici";
import { wrapFetchWithAbortSignal } from "../infra/fetch.js";
export function makeProxyFetch(proxyUrl) {
  const agent = new ProxyAgent(proxyUrl);
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  const fetcher = (input, init) =>
    undiciFetch(input, {
      ...init,
      dispatcher: agent,
    });
  return wrapFetchWithAbortSignal(fetcher);
}
