import type { VersoConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { confirm, text } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

const DEFAULT_RESERVE_TOKENS_FLOOR = 8_000;
const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 8_000;

/**
 * Prompt the user for compaction settings.
 * These settings control how the agent manages memory and context limits.
 */
export async function promptCompactionConfig(
  nextConfig: VersoConfig,
  runtime: RuntimeEnv,
): Promise<VersoConfig> {
  const existingDefaults = nextConfig.agents?.defaults;
  const existingCompaction = existingDefaults?.compaction;
  const existingMemoryFlush = existingCompaction?.memoryFlush;

  note(
    [
      "Compaction settings control when the agent compresses conversation history.",
      "",
      "• Reserve tokens: Buffer kept for new responses during compaction.",
      "• Memory flush: Saves important memories before compaction kicks in.",
      "",
      "Note: With dynamic context, the model's native context window is used automatically.",
      "",
      "Docs: https://docs.molt.bot/agents/compaction",
    ].join("\n"),
    "Compaction Settings",
  );

  // 1. Reserve tokens floor (compaction buffer)
  const reserveTokensRaw = guardCancel(
    await text({
      message: "Compaction buffer (tokens to reserve for new responses)",
      initialValue: String(existingCompaction?.reserveTokensFloor ?? DEFAULT_RESERVE_TOKENS_FLOOR),
      placeholder: "Lower = earlier compaction (recommended: 4000-12000)",
    }),
    runtime,
  );
  const reserveTokensFloor = Number.parseInt(String(reserveTokensRaw).trim(), 10);
  const validReserveTokens =
    Number.isFinite(reserveTokensFloor) && reserveTokensFloor >= 0
      ? reserveTokensFloor
      : (existingCompaction?.reserveTokensFloor ?? DEFAULT_RESERVE_TOKENS_FLOOR);

  // 2. Memory flush enabled
  const memoryFlushEnabled = guardCancel(
    await confirm({
      message: "Enable pre-compaction memory flush? (saves memories before compacting)",
      initialValue: existingMemoryFlush?.enabled ?? true,
    }),
    runtime,
  );

  // 3. Memory flush soft threshold (only if enabled)
  let memoryFlushSoftTokens =
    existingMemoryFlush?.softThresholdTokens ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS;
  if (memoryFlushEnabled) {
    const softTokensRaw = guardCancel(
      await text({
        message: "Memory flush threshold (tokens before compaction to trigger flush)",
        initialValue: String(memoryFlushSoftTokens),
        placeholder: "Higher = more time for memory flush (recommended: 6000-12000)",
      }),
      runtime,
    );
    const parsed = Number.parseInt(String(softTokensRaw).trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      memoryFlushSoftTokens = parsed;
    }
  }

  return {
    ...nextConfig,
    agents: {
      ...nextConfig.agents,
      defaults: {
        ...existingDefaults,
        compaction: {
          ...existingCompaction,
          reserveTokensFloor: validReserveTokens,
          memoryFlush: {
            ...existingMemoryFlush,
            enabled: memoryFlushEnabled,
            softThresholdTokens: memoryFlushSoftTokens,
          },
        },
      },
    },
  };
}
