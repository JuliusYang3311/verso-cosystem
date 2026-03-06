import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
export const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-large";
const DEFAULT_VOYAGE_BASE_URL = "https://api.voyageai.com/v1";
export function normalizeVoyageModel(model) {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_VOYAGE_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("voyage/")) {
    return trimmed.slice("voyage/".length);
  }
  return trimmed;
}
export async function createVoyageEmbeddingProvider(options) {
  const client = await resolveVoyageEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;
  const embed = async (input, input_type) => {
    if (input.length === 0) {
      return [];
    }
    const body = {
      model: client.model,
      input,
    };
    if (input_type) {
      body.input_type = input_type;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`voyage embeddings failed: ${res.status} ${text}`);
    }
    const payload = await res.json();
    const data = payload.data ?? [];
    return data.map((entry) => entry.embedding ?? []);
  };
  return {
    provider: {
      id: "voyage",
      model: client.model,
      embedQuery: async (text) => {
        const [vec] = await embed([text], "query");
        return vec ?? [];
      },
      embedBatch: async (texts) => embed(texts, "document"),
    },
    client,
  };
}
export async function resolveVoyageEmbeddingClient(options) {
  const remote = options.remote;
  const remoteApiKey = remote?.apiKey?.trim();
  const remoteBaseUrl = remote?.baseUrl?.trim();
  const apiKey = remoteApiKey
    ? remoteApiKey
    : requireApiKey(
        await resolveApiKeyForProvider({
          provider: "voyage",
          cfg: options.config,
          agentDir: options.agentDir,
        }),
        "voyage",
      );
  const providerConfig = options.config.models?.providers?.voyage;
  const baseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || DEFAULT_VOYAGE_BASE_URL;
  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...headerOverrides,
  };
  const model = normalizeVoyageModel(options.model);
  return { baseUrl, headers, model };
}
