// src/orchestration/session-key-validation.ts — Session key validation for orchestration notifications

import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("orchestration-session-validation");

export type SessionKeyValidationResult = {
  valid: boolean;
  normalized?: string;
  reason?: string;
};

/**
 * Validate and normalize a session key for orchestration notification delivery.
 *
 * Valid session keys:
 * - telegram:chat:123456
 * - discord:channel:789012
 * - slack:channel:C123456
 * - agent:myagent
 * - agent:main (only if it's a real agent session, not a placeholder)
 *
 * Invalid session keys:
 * - agent:main (when used as placeholder)
 * - Empty or undefined
 * - Less than 2 parts (missing channel/chat ID)
 */
export function validateSessionKey(
  sessionKey: string | undefined,
  context: {
    orchestrationId: string;
    orchestratorSessionKey: string;
  },
): SessionKeyValidationResult {
  // Check if session key is provided
  if (!sessionKey || typeof sessionKey !== "string" || sessionKey.trim() === "") {
    logger.warn("Session key is empty or undefined", {
      orchestrationId: context.orchestrationId,
      orchestratorSessionKey: context.orchestratorSessionKey,
    });
    return {
      valid: false,
      reason: "Session key is empty or undefined",
    };
  }

  const normalized = sessionKey.trim();

  // Check minimum format: must have at least 2 parts separated by ":"
  const parts = normalized.split(":");
  if (parts.length < 2) {
    logger.warn("Session key has invalid format (less than 2 parts)", {
      orchestrationId: context.orchestrationId,
      sessionKey: normalized,
      parts: parts.length,
    });
    return {
      valid: false,
      reason: `Session key has invalid format: "${normalized}" (expected format: "provider:channel:id" or "agent:agentId")`,
    };
  }

  // Special case: "agent:main" is often a placeholder, not a real session
  // We need to check if it's derived from orchestratorSessionKey
  if (normalized === "agent:main") {
    // If orchestratorSessionKey is "agent:main:orch:xxx", then "agent:main" is valid
    // Otherwise, it's likely a placeholder
    if (context.orchestratorSessionKey.startsWith("agent:main:orch:")) {
      logger.info("Session key 'agent:main' validated (derived from orchestratorSessionKey)", {
        orchestrationId: context.orchestrationId,
      });
      return {
        valid: true,
        normalized,
      };
    } else {
      logger.warn("Session key 'agent:main' is likely a placeholder", {
        orchestrationId: context.orchestrationId,
        orchestratorSessionKey: context.orchestratorSessionKey,
      });
      return {
        valid: false,
        reason:
          "Session key 'agent:main' is a placeholder and cannot receive notifications. Please provide a specific session key (e.g., telegram:chat:123456).",
      };
    }
  }

  // Valid session key
  logger.info("Session key validated", {
    orchestrationId: context.orchestrationId,
    sessionKey: normalized,
  });

  return {
    valid: true,
    normalized,
  };
}

/**
 * Resolve the target session key for orchestration notifications.
 *
 * Priority:
 * 1. triggeringSessionKey (explicitly set when orchestration was created)
 * 2. Extract from orchestratorSessionKey (agent:<agentId>:orch:<orchId> → agent:<agentId>)
 * 3. Fallback to null (no valid target)
 */
export function resolveTargetSessionKey(params: {
  triggeringSessionKey?: string;
  orchestratorSessionKey: string;
  orchestrationId: string;
}): string | null {
  // Priority 1: triggeringSessionKey
  if (params.triggeringSessionKey) {
    const validation = validateSessionKey(params.triggeringSessionKey, {
      orchestrationId: params.orchestrationId,
      orchestratorSessionKey: params.orchestratorSessionKey,
    });

    if (validation.valid) {
      return validation.normalized!;
    } else {
      logger.warn("triggeringSessionKey is invalid", {
        orchestrationId: params.orchestrationId,
        triggeringSessionKey: params.triggeringSessionKey,
        reason: validation.reason,
      });
    }
  }

  // Priority 2: Extract from orchestratorSessionKey
  if (params.orchestratorSessionKey) {
    const parts = params.orchestratorSessionKey.split(":orch:");
    if (parts.length > 0 && parts[0]) {
      const extracted = parts[0];
      const validation = validateSessionKey(extracted, {
        orchestrationId: params.orchestrationId,
        orchestratorSessionKey: params.orchestratorSessionKey,
      });

      if (validation.valid) {
        logger.info("Extracted target session key from orchestratorSessionKey", {
          orchestrationId: params.orchestrationId,
          extracted: validation.normalized,
        });
        return validation.normalized!;
      } else {
        logger.warn("Extracted session key from orchestratorSessionKey is invalid", {
          orchestrationId: params.orchestrationId,
          extracted,
          reason: validation.reason,
        });
      }
    }
  }

  // No valid target
  logger.warn("No valid target session key found", {
    orchestrationId: params.orchestrationId,
    triggeringSessionKey: params.triggeringSessionKey,
    orchestratorSessionKey: params.orchestratorSessionKey,
  });

  return null;
}
