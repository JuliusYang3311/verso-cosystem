// src/orchestration/specializations/types.ts — Worker specialization types

/**
 * Worker specialization types for domain-specific task execution.
 * Inspired by Claude Code's specialized agent architecture.
 */
export type WorkerSpecialization =
  | "code-explorer" // Understand existing codebase, trace features
  | "code-architect" // Design architecture, plan implementation
  | "code-implementer" // Write code, implement features
  | "code-reviewer" // Review code quality, find bugs
  | "researcher" // Gather information, analyze data
  | "generic"; // Fallback for other tasks

/**
 * Get human-readable description of a specialization
 */
export function getSpecializationDescription(spec: WorkerSpecialization): string {
  const descriptions: Record<WorkerSpecialization, string> = {
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
export function requiresCodebaseContext(spec: WorkerSpecialization): boolean {
  return spec === "code-explorer" || spec === "code-architect" || spec === "code-reviewer";
}
