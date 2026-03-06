import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostname,
  resolvePinnedHostnameWithPolicy,
} from "./ssrf.js";
const DEFAULT_MAX_REDIRECTS = 3;
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function buildAbortSignal(params) {
  const { timeoutMs, signal } = params;
  if (!timeoutMs && !signal) {
    return { signal: undefined, cleanup: () => {} };
  }
  if (!timeoutMs) {
    return { signal, cleanup: () => {} };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const cleanup = () => {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  };
  return { signal: controller.signal, cleanup };
}
export async function fetchWithSsrFGuard(params) {
  const fetcher = params.fetchImpl ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("fetch is not available");
  }
  const maxRedirects =
    typeof params.maxRedirects === "number" && Number.isFinite(params.maxRedirects)
      ? Math.max(0, Math.floor(params.maxRedirects))
      : DEFAULT_MAX_REDIRECTS;
  const { signal, cleanup } = buildAbortSignal({
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  let released = false;
  const release = async (dispatcher) => {
    if (released) {
      return;
    }
    released = true;
    cleanup();
    await closeDispatcher(dispatcher ?? undefined);
  };
  const visited = new Set();
  let currentUrl = params.url;
  let redirectCount = 0;
  while (true) {
    let parsedUrl;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }
    let dispatcher = null;
    try {
      const usePolicy = Boolean(
        params.policy?.allowPrivateNetwork || params.policy?.allowedHostnames?.length,
      );
      const pinned = usePolicy
        ? await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
            lookupFn: params.lookupFn,
            policy: params.policy,
          })
        : await resolvePinnedHostname(parsedUrl.hostname, params.lookupFn);
      if (params.pinDns !== false) {
        dispatcher = createPinnedDispatcher(pinned);
      }
      const init = {
        ...(params.init ? { ...params.init } : {}),
        redirect: "manual",
        ...(dispatcher ? { dispatcher } : {}),
        ...(signal ? { signal } : {}),
      };
      const response = await fetcher(parsedUrl.toString(), init);
      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          await release(dispatcher);
          throw new Error(`Redirect missing location header (${response.status})`);
        }
        redirectCount += 1;
        if (redirectCount > maxRedirects) {
          await release(dispatcher);
          throw new Error(`Too many redirects (limit: ${maxRedirects})`);
        }
        const nextUrl = new URL(location, parsedUrl).toString();
        if (visited.has(nextUrl)) {
          await release(dispatcher);
          throw new Error("Redirect loop detected");
        }
        visited.add(nextUrl);
        void response.body?.cancel();
        await closeDispatcher(dispatcher);
        currentUrl = nextUrl;
        continue;
      }
      return {
        response,
        finalUrl: currentUrl,
        release: async () => release(dispatcher),
      };
    } catch (err) {
      await release(dispatcher);
      throw err;
    }
  }
}
