// src/orchestration/specializations/index.ts — Specialization registry and utilities
import { CODE_ARCHITECT_PROMPT } from "./code-architect.js";
import { CODE_EXPLORER_PROMPT } from "./code-explorer.js";
import { CODE_IMPLEMENTER_PROMPT } from "./code-implementer.js";
import { CODE_REVIEWER_PROMPT } from "./code-reviewer.js";
import { RESEARCHER_PROMPT } from "./researcher.js";
import { getSpecializationDescription, requiresCodebaseContext } from "./types.js";
/**
 * Get the specialized prompt for a given worker specialization
 */
export function getSpecializationPrompt(specialization) {
  const prompts = {
    "code-explorer": CODE_EXPLORER_PROMPT,
    "code-architect": CODE_ARCHITECT_PROMPT,
    "code-implementer": CODE_IMPLEMENTER_PROMPT,
    "code-reviewer": CODE_REVIEWER_PROMPT,
    researcher: RESEARCHER_PROMPT,
    generic: "", // No specialized prompt for generic workers
  };
  return prompts[specialization];
}
export { getSpecializationDescription, requiresCodebaseContext };
