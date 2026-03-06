// src/orchestration/specializations/types.ts — Worker specialization types
/**
 * Get human-readable description of a specialization
 */
export function getSpecializationDescription(spec) {
  const descriptions = {
    "code-explorer":
      "Expert code analyst specializing in tracing and understanding feature implementations",
    "code-architect": "Architecture designer specializing in planning implementation approaches",
    "code-implementer": "Software engineer specializing in writing clean, maintainable code",
    "code-reviewer": "Quality assurance specialist focusing on bugs, patterns, and best practices",
    researcher: "Research analyst specializing in information gathering and analysis",
    generic: "General-purpose worker for various tasks",
  };
  return descriptions[spec];
}
/**
 * Determine if a specialization requires existing codebase context
 */
export function requiresCodebaseContext(spec) {
  return spec === "code-explorer" || spec === "code-architect" || spec === "code-reviewer";
}
