import { Type } from "@sinclair/typebox";
import type { VersoConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { emitFactorHit, emitFactorMiss } from "../../evolver/dimension-hooks.js";
import {
  loadFactorSpace,
  queryToSubqueries,
  ensureFactorVectors,
  type FactorScore,
  type LatentFactorSpace,
} from "../../memory/latent-factors.js";
import { wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { loadContextParams } from "../dynamic-context.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./web-shared.js";

const WEB_PROVIDER_MODEL = "web-search-agent";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

// ---------- Types ----------

type WebSearchConfig = NonNullable<VersoConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type RawWebResult = {
  url: string;
  title: string;
  description: string;
  published?: string;
  siteName?: string;
  factorId: string;
  score: number;
};

type MergedWebResult = {
  url: string;
  title: string;
  description: string;
  published?: string;
  siteName?: string;
  score: number;
  factorsUsed: Array<{ id: string; score: number }>;
};

// ---------- Config helpers ----------

function resolveSearchConfig(cfg?: VersoConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search as WebSearchConfig;
}

function resolveSearchApiKey(search?: WebSearchConfig): string | undefined {
  const fromConfig =
    search && "apiKey" in search && typeof search.apiKey === "string"
      ? normalizeSecretInput(search.apiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.BRAVE_API_KEY);
  return fromConfig || fromEnv || undefined;
}

// ---------- UI language ----------

const BRAVE_UI_LANG_VALUES = new Set([
  "es-AR",
  "en-AU",
  "de-AT",
  "nl-BE",
  "fr-BE",
  "pt-BR",
  "en-CA",
  "fr-CA",
  "es-CL",
  "da-DK",
  "fi-FI",
  "fr-FR",
  "de-DE",
  "el-GR",
  "zh-HK",
  "en-IN",
  "en-ID",
  "it-IT",
  "ja-JP",
  "ko-KR",
  "en-MY",
  "es-MX",
  "nl-NL",
  "en-NZ",
  "no-NO",
  "zh-CN",
  "pl-PL",
  "en-PH",
  "ru-RU",
  "en-ZA",
  "es-ES",
  "sv-SE",
  "fr-CH",
  "de-CH",
  "zh-TW",
  "tr-TR",
  "en-GB",
  "en-US",
  "es-US",
]);

// Map bare language codes to the most common Brave ui_lang value.
const BARE_LANG_TO_UI_LANG: Record<string, string> = {
  en: "en-US",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  it: "it-IT",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
  pt: "pt-BR",
  nl: "nl-NL",
  ru: "ru-RU",
  pl: "pl-PL",
  sv: "sv-SE",
  da: "da-DK",
  fi: "fi-FI",
  no: "no-NO",
  tr: "tr-TR",
  el: "el-GR",
};

function normalizeUiLang(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (BRAVE_UI_LANG_VALUES.has(trimmed)) {
    return trimmed;
  }
  const mapped = BARE_LANG_TO_UI_LANG[trimmed.toLowerCase()];
  return mapped ?? undefined;
}

// ---------- Freshness ----------

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return lower;
  }
  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) {
    return undefined;
  }
  const [, start, end] = match;
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return undefined;
  }
  if (start > end) {
    return undefined;
  }
  return `${start}to${end}`;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((p) => Number.parseInt(p, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

// ---------- Brave subquery ----------

async function runBraveSubquery(params: {
  subquery: string;
  factorId: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  country?: string;
  searchLang?: string;
  uiLang?: string;
  freshness?: string;
}): Promise<RawWebResult[]> {
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.subquery);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.searchLang) {
    url.searchParams.set("search_lang", params.searchLang);
  }
  if (params.uiLang) {
    url.searchParams.set("ui_lang", params.uiLang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey,
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
  };
  const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];

  return results.map((entry, idx) => {
    const entryUrl = entry.url ?? "";
    let siteName: string | undefined;
    try {
      siteName = new URL(entryUrl).hostname;
    } catch {
      siteName = undefined;
    }
    return {
      url: entryUrl,
      title: entry.title ? wrapWebContent(entry.title, "brave_search") : "",
      description: entry.description ? wrapWebContent(entry.description, "brave_search") : "",
      published: entry.age || undefined,
      siteName,
      factorId: params.factorId,
      score: 1 / (idx + 1),
    };
  });
}

// ---------- URL deduplication ----------

export function deduplicateWebResults(results: RawWebResult[]): MergedWebResult[] {
  const map = new Map<string, MergedWebResult>();

  for (const r of results) {
    const key = r.url.toLowerCase().replace(/\/$/, "");
    const existing = map.get(key);

    if (!existing) {
      map.set(key, {
        url: r.url,
        title: r.title,
        description: r.description,
        published: r.published,
        siteName: r.siteName,
        score: r.score,
        factorsUsed: [{ id: r.factorId, score: r.score }],
      });
      continue;
    }

    const mergedScore = Math.max(existing.score, r.score);
    const factorMap = new Map(existing.factorsUsed.map((f) => [f.id, f]));
    const prev = factorMap.get(r.factorId);
    if (!prev || r.score > prev.score) {
      factorMap.set(r.factorId, { id: r.factorId, score: r.score });
    }
    map.set(key, {
      ...existing,
      score: mergedScore,
      factorsUsed: [...factorMap.values()].toSorted((a, b) => b.score - a.score),
    });
  }

  return [...map.values()];
}

// ---------- MMR result selection ----------

function snippetSimilarity(a: MergedWebResult, b: MergedWebResult): number {
  const bigramSet = (s: string): Set<string> => {
    const set = new Set<string>();
    const lower = s.toLowerCase();
    for (let i = 0; i < lower.length - 1; i++) {
      set.add(lower.slice(i, i + 2));
    }
    return set;
  };
  const text = (r: MergedWebResult) => `${r.title} ${r.description}`;
  const setA = bigramSet(text(a));
  const setB = bigramSet(text(b));
  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function resultTokens(r: MergedWebResult): number {
  return Math.ceil(`${r.title} ${r.description}`.length / 4);
}

export function mmrSelectWebResults(
  candidates: MergedWebResult[],
  lambda: number,
  minGain: number,
  budgetTokens: number,
): MergedWebResult[] {
  if (candidates.length === 0) {
    return [];
  }

  const selected: MergedWebResult[] = [];
  const remaining = [...candidates];
  let tokensUsed = 0;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      const maxSim =
        selected.length === 0
          ? 0
          : Math.max(...selected.map((s) => snippetSimilarity(remaining[i], s)));
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    if (bestMmr < minGain) {
      break;
    }

    const candidate = remaining[bestIdx];
    if (tokensUsed + resultTokens(candidate) > budgetTokens) {
      break;
    }

    remaining.splice(bestIdx, 1);
    selected.push(candidate);
    tokensUsed += resultTokens(candidate);
  }

  return selected;
}

// ---------- Per-factor count ----------

export function perFactorCount(targetTotal: number, factorCount: number): number {
  return factorCount <= 0 ? targetTotal : Math.ceil(targetTotal / factorCount);
}

// ---------- Subquery resolution ----------

type Subquery = { factorId: string; subquery: string };
type SubqueryPlan = { selectedFactors: FactorScore[]; subqueries: Subquery[] };

function resolveSubqueries(
  space: LatentFactorSpace,
  query: string,
  mmrLambda: number,
  queryVec: number[] = [],
): SubqueryPlan {
  if (space.factors.length === 0) {
    return { selectedFactors: [], subqueries: [{ factorId: "direct", subquery: query }] };
  }
  return queryToSubqueries({
    queryVec,
    queryText: query,
    space,
    providerModel: WEB_PROVIDER_MODEL,
    useCase: "web",
    threshold: 1 / space.factors.length,
    mmrLambda,
  });
}

// ---------- Main pipeline ----------

async function runWebSearch(params: {
  query: string;
  resultsPerFactor?: number;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  mmrLambda: number;
  minMmrGain: number;
  budgetTokens: number;
  country?: string;
  searchLang?: string;
  uiLang?: string;
  freshness?: string;
  embedBatch?: (texts: string[]) => Promise<number[][]>;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `brave:${params.query}:${params.resultsPerFactor ?? "auto"}:${params.mmrLambda}:${params.budgetTokens}:${params.country ?? ""}:${params.freshness ?? ""}`,
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();

  let space: LatentFactorSpace = await loadFactorSpace();

  // Embed query and ensure factor vectors in parallel; reload space after to get fresh vectors.
  let queryVec: number[] = [];
  if (params.embedBatch && space.factors.length > 0) {
    const [vecs] = await Promise.all([
      params.embedBatch([params.query]).catch(() => null),
      ensureFactorVectors(space, WEB_PROVIDER_MODEL, "web", params.embedBatch).catch(() => {}),
    ]);
    // Reload to pick up any newly registered factor vectors.
    space = await loadFactorSpace();
    if (vecs?.[0]?.length) {
      queryVec = vecs[0];
    }
  }

  const { selectedFactors, subqueries } = resolveSubqueries(
    space,
    params.query,
    params.mmrLambda,
    queryVec,
  );

  const countPerFactor = params.resultsPerFactor ?? perFactorCount(10, subqueries.length);

  const subResults = await Promise.allSettled(
    subqueries.map(({ factorId, subquery }) =>
      runBraveSubquery({
        subquery,
        factorId,
        count: countPerFactor,
        apiKey: params.apiKey,
        timeoutSeconds: params.timeoutSeconds,
        country: params.country,
        searchLang: params.searchLang,
        uiLang: params.uiLang,
        freshness: params.freshness,
      }),
    ),
  );

  const allRaw: RawWebResult[] = [];
  const factorErrors: string[] = [];
  for (let i = 0; i < subResults.length; i++) {
    const r = subResults[i];
    if (r.status === "fulfilled") {
      allRaw.push(...r.value);
      // Emit hit signal: factor produced results
      if (r.value.length > 0 && subqueries[i].factorId !== "direct") {
        const avgScore = r.value.reduce((s, v) => s + v.score, 0) / r.value.length;
        emitFactorHit(
          subqueries[i].factorId,
          params.query.slice(0, 80),
          avgScore,
          WEB_PROVIDER_MODEL,
          "web",
        );
      }
    } else {
      factorErrors.push(`${subqueries[i].factorId}: ${String(r.reason)}`);
    }
  }
  // Emit miss signals for factors that returned zero results
  for (let i = 0; i < subResults.length; i++) {
    const r = subResults[i];
    const fid = subqueries[i].factorId;
    if (fid === "direct") continue;
    if (r.status === "fulfilled" && r.value.length === 0) {
      emitFactorMiss(fid, params.query.slice(0, 80), WEB_PROVIDER_MODEL, "web");
    }
  }

  const merged = deduplicateWebResults(allRaw);
  const sorted = merged.toSorted((a, b) => b.score - a.score);
  const selected = mmrSelectWebResults(
    sorted,
    params.mmrLambda,
    params.minMmrGain,
    params.budgetTokens,
  );

  const payload: Record<string, unknown> = {
    query: params.query,
    provider: "brave",
    factorsActivated: selectedFactors.map((f: FactorScore) => ({
      id: f.factor.id,
      score: f.score,
      rawScore: f.rawScore,
      subquery: subqueries.find((s) => s.factorId === f.factor.id)?.subquery,
    })),
    countPerFactor,
    rawCount: allRaw.length,
    mergedCount: merged.length,
    count: selected.length,
    tookMs: Date.now() - start,
    results: selected.map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
      published: r.published,
      siteName: r.siteName,
      score: r.score,
      factorsUsed: r.factorsUsed,
    })),
  };

  if (factorErrors.length > 0) {
    payload.warnings = factorErrors;
  }

  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

// ---------- Schema ----------

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  country: Type.Optional(
    Type.String({
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
    }),
  ),
  search_lang: Type.Optional(
    Type.String({
      description: "ISO language code for search results (e.g., 'de', 'en', 'fr').",
    }),
  ),
  ui_lang: Type.Optional(
    Type.String({
      description: "ISO language code for UI elements.",
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        "Filter results by discovery time. Values: 'pd' (past 24h), 'pw' (past week), 'pm' (past month), 'py' (past year), or date range 'YYYY-MM-DDtoYYYY-MM-DD'.",
    }),
  ),
  mmr_lambda: Type.Optional(
    Type.Number({
      description: "MMR trade-off: 1.0 = pure relevance, 0.0 = pure diversity.",
      minimum: 0,
      maximum: 1,
    }),
  ),
  budget_tokens: Type.Optional(
    Type.Number({
      description: "Token budget for MMR result selection.",
      minimum: 100,
    }),
  ),
});

// ---------- Tool factory ----------

export function createWebSearchTool(options?: {
  config?: VersoConfig;
  sandboxed?: boolean;
  embedBatch?: (texts: string[]) => Promise<number[][]>;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  const apiKey = resolveSearchApiKey(search);

  return {
    label: "Web Search",
    name: "brave_search",
    description:
      "Search the web using Brave Search. Decomposes the query into semantically diverse sub-queries via the latent factor space, runs them in parallel, deduplicates by URL, and applies MMR diversity selection. Returns a compact, diverse result set covering multiple information dimensions.",
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args) => {
      if (!apiKey) {
        return jsonResult({
          error: "missing_brave_api_key",
          message: `brave_search needs a Brave Search API key. Run \`${formatCliCommand("verso configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
          docs: "https://docs.verso.ai/tools/web",
        });
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const country = readStringParam(params, "country");
      const search_lang = readStringParam(params, "search_lang");
      const ui_lang = normalizeUiLang(readStringParam(params, "ui_lang"));
      const rawFreshness = readStringParam(params, "freshness");
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
      if (rawFreshness && !freshness) {
        return jsonResult({
          error: "invalid_freshness",
          message:
            "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
          docs: "https://docs.verso.ai/tools/web",
        });
      }

      const ctxParams = await loadContextParams();

      const mmrLambda = (() => {
        const v = readNumberParam(params, "mmr_lambda");
        return typeof v === "number" && Number.isFinite(v)
          ? Math.max(0, Math.min(1, v))
          : (ctxParams.webSearchMmrLambda ?? 0.7);
      })();

      const budgetTokens = (() => {
        const v = readNumberParam(params, "budget_tokens", { integer: true });
        return typeof v === "number" && v >= 100
          ? Math.floor(v)
          : (ctxParams.webSearchBudgetTokens ?? 8000);
      })();

      const result = await runWebSearch({
        query,
        apiKey,
        timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        mmrLambda,
        minMmrGain: ctxParams.webSearchMmrMinGain ?? 0.05,
        budgetTokens,
        country,
        searchLang: search_lang,
        uiLang: ui_lang,
        freshness,
        embedBatch: options?.embedBatch,
      });

      return jsonResult(result);
    },
  };
}

export const __testing = {
  normalizeFreshness,
  deduplicateWebResults,
  mmrSelectWebResults,
  perFactorCount,
} as const;
