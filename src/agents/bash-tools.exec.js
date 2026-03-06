import { Type } from "@sinclair/typebox";
import { maxAsk, minSecurity, resolveSafeBins } from "../infra/exec-approvals.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { logInfo } from "../logger.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { markBackgrounded } from "./bash-process-registry.js";
import {
  buildSandboxEnv,
  clampWithDefault,
  coerceEnv,
  readEnvInt,
  resolveSandboxWorkdir,
  resolveWorkdir,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { executeOnNode, checkGatewayApproval } from "./exec-approval-check.js";
import {
  applyPathPrepend,
  applyShellPath,
  normalizePathPrepend,
  resolveSkillConfigEnv,
  validateHostEnv,
} from "./exec-env.js";
import { runExecProcess } from "./exec-run-process.js";
import { getSessionVenvPath } from "./session-venv.js";
const DEFAULT_MAX_OUTPUT = clampWithDefault(
  readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000,
);
const DEFAULT_PENDING_MAX_OUTPUT = clampWithDefault(
  readEnvInt("VERSO_BASH_PENDING_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000,
);
const DEFAULT_PATH =
  process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 10_000;
const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description:
        "Run in a pseudo-terminal (PTY) when available (TTY-required CLIs, coding agents)",
    }),
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Run on the host with elevated permissions (if allowed)",
    }),
  ),
  host: Type.Optional(
    Type.String({
      description: "Exec host (sandbox|gateway|node).",
    }),
  ),
  security: Type.Optional(
    Type.String({
      description: "Exec security mode (deny|allowlist|full).",
    }),
  ),
  ask: Type.Optional(
    Type.String({
      description: "Exec ask mode (off|on-miss|always).",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description: "Node id/name for host=node.",
    }),
  ),
});
function normalizeExecHost(value) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return null;
}
function normalizeExecSecurity(value) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}
function normalizeExecAsk(value) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return null;
}
function renderExecHostLabel(host) {
  return host === "sandbox" ? "sandbox" : host === "gateway" ? "gateway" : "node";
}
function resolveApprovalRunningNoticeMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}
export function createExecTool(defaults) {
  const defaultBackgroundMs = clampWithDefault(
    defaults?.backgroundMs ?? readEnvInt("PI_BASH_YIELD_MS"),
    10_000,
    10,
    120_000,
  );
  const allowBackground = defaults?.allowBackground ?? true;
  const defaultTimeoutSec =
    typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
      ? defaults.timeoutSec
      : 1800;
  const defaultPathPrepend = normalizePathPrepend(defaults?.pathPrepend);
  const safeBins = resolveSafeBins(defaults?.safeBins);
  const notifyOnExit = defaults?.notifyOnExit !== false;
  const notifySessionKey = defaults?.sessionKey?.trim() || undefined;
  const approvalRunningNoticeMs = resolveApprovalRunningNoticeMs(defaults?.approvalRunningNoticeMs);
  // Derive agentId only when sessionKey is an agent session key.
  const parsedAgentSession = parseAgentSessionKey(defaults?.sessionKey);
  const agentId =
    defaults?.agentId ??
    (parsedAgentSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : undefined);
  return {
    name: "exec",
    label: "exec",
    description:
      "Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool. Use pty=true for TTY-required commands (terminal UIs, coding agents).",
    parameters: execSchema,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const params = args;
      if (!params.command) {
        throw new Error("Provide a command to start.");
      }
      const maxOutput = DEFAULT_MAX_OUTPUT;
      const pendingMaxOutput = DEFAULT_PENDING_MAX_OUTPUT;
      const warnings = [];
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";
      if (!allowBackground && (backgroundRequested || yieldRequested)) {
        warnings.push("Warning: background execution is disabled; running synchronously.");
      }
      const yieldWindow = allowBackground
        ? backgroundRequested
          ? 0
          : clampWithDefault(
              params.yieldMs ?? defaultBackgroundMs,
              defaultBackgroundMs,
              10,
              120_000,
            )
        : null;
      const elevatedDefaults = defaults?.elevated;
      const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);
      const elevatedDefaultMode =
        elevatedDefaults?.defaultLevel === "full"
          ? "full"
          : elevatedDefaults?.defaultLevel === "ask"
            ? "ask"
            : elevatedDefaults?.defaultLevel === "on"
              ? "ask"
              : "off";
      const effectiveDefaultMode = elevatedAllowed ? elevatedDefaultMode : "off";
      const elevatedMode =
        typeof params.elevated === "boolean"
          ? params.elevated
            ? elevatedDefaultMode === "full"
              ? "full"
              : "ask"
            : "off"
          : effectiveDefaultMode;
      const elevatedRequested = elevatedMode !== "off";
      if (elevatedRequested) {
        if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
          const runtime = defaults?.sandbox ? "sandboxed" : "direct";
          const gates = [];
          const contextParts = [];
          const provider = defaults?.messageProvider?.trim();
          const sessionKey = defaults?.sessionKey?.trim();
          if (provider) {
            contextParts.push(`provider=${provider}`);
          }
          if (sessionKey) {
            contextParts.push(`session=${sessionKey}`);
          }
          if (!elevatedDefaults?.enabled) {
            gates.push("enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled)");
          } else {
            gates.push(
              "allowFrom (tools.elevated.allowFrom.<provider> / agents.list[].tools.elevated.allowFrom.<provider>)",
            );
          }
          throw new Error(
            [
              `elevated is not available right now (runtime=${runtime}).`,
              `Failing gates: ${gates.join(", ")}`,
              contextParts.length > 0 ? `Context: ${contextParts.join(" ")}` : undefined,
              "Fix-it keys:",
              "- tools.elevated.enabled",
              "- tools.elevated.allowFrom.<provider>",
              "- agents.list[].tools.elevated.enabled",
              "- agents.list[].tools.elevated.allowFrom.<provider>",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
      }
      if (elevatedRequested) {
        logInfo(`exec: elevated command ${truncateMiddle(params.command, 120)}`);
      }
      const configuredHost = defaults?.host ?? "sandbox";
      const requestedHost = normalizeExecHost(params.host) ?? null;
      let host = requestedHost ?? configuredHost;
      if (!elevatedRequested && requestedHost && requestedHost !== configuredHost) {
        throw new Error(
          `exec host not allowed (requested ${renderExecHostLabel(requestedHost)}; ` +
            `configure tools.exec.host=${renderExecHostLabel(configuredHost)} to allow).`,
        );
      }
      if (elevatedRequested) {
        host = "gateway";
      }
      const configuredSecurity = defaults?.security ?? (host === "sandbox" ? "deny" : "allowlist");
      const requestedSecurity = normalizeExecSecurity(params.security);
      let security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);
      if (elevatedRequested && elevatedMode === "full") {
        security = "full";
      }
      const configuredAsk = defaults?.ask ?? "on-miss";
      const requestedAsk = normalizeExecAsk(params.ask);
      let ask = maxAsk(configuredAsk, requestedAsk ?? configuredAsk);
      const bypassApprovals = elevatedRequested && elevatedMode === "full";
      if (bypassApprovals) {
        ask = "off";
      }
      const sandbox = host === "sandbox" ? defaults?.sandbox : undefined;
      const rawWorkdir = params.workdir?.trim() || defaults?.cwd || process.cwd();
      let workdir = rawWorkdir;
      let containerWorkdir = sandbox?.containerWorkdir;
      if (sandbox) {
        const resolved = await resolveSandboxWorkdir({
          workdir: rawWorkdir,
          sandbox,
          warnings,
        });
        workdir = resolved.hostWorkdir;
        containerWorkdir = resolved.containerWorkdir;
      } else {
        workdir = resolveWorkdir(rawWorkdir, warnings);
      }
      const configEnv = resolveSkillConfigEnv();
      const baseEnv = { ...configEnv, ...coerceEnv(process.env) };
      // Logic: Sandbox gets raw env. Host (gateway/node) must pass validation.
      // We validate BEFORE merging to prevent any dangerous vars from entering the stream.
      if (host !== "sandbox" && params.env) {
        validateHostEnv(params.env);
      }
      const mergedEnv = params.env ? { ...baseEnv, ...params.env } : baseEnv;
      const sandboxParamsEnv = sandbox
        ? (() => {
            const copy = { ...mergedEnv };
            delete copy.PATH;
            delete copy.HOME;
            return copy;
          })()
        : undefined;
      const env = sandbox
        ? buildSandboxEnv({
            defaultPath: DEFAULT_PATH,
            paramsEnv: sandboxParamsEnv,
            sandboxEnv: sandbox.env,
            containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir,
          })
        : mergedEnv;
      if (!sandbox && host === "gateway" && !params.env?.PATH) {
        const shellPath = getShellPathFromLoginShell({
          env: process.env,
          timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env),
        });
        applyShellPath(env, shellPath);
      }
      applyPathPrepend(env, defaultPathPrepend);
      // Inject session venv into PATH if available.
      const sessionVenvPath = defaults?.sessionKey ? getSessionVenvPath(defaults.sessionKey) : null;
      if (sessionVenvPath) {
        const venvBin = `${sessionVenvPath}/bin`;
        env.VIRTUAL_ENV = sessionVenvPath;
        env.PATH = env.PATH ? `${venvBin}:${env.PATH}` : venvBin;
      }
      // ── Node host execution ──────────────────────────────
      if (host === "node") {
        return executeOnNode({
          command: params.command,
          workdir,
          env,
          paramsEnv: params.env,
          paramTimeout: params.timeout,
          paramPty: params.pty,
          defaultTimeoutSec,
          security,
          ask,
          agentId,
          boundNode: defaults?.node?.trim(),
          requestedNode: params.node?.trim(),
          defaultPathPrepend,
          defaultsSessionKey: defaults?.sessionKey,
          notifySessionKey,
          approvalRunningNoticeMs,
          warnings,
        });
      }
      // ── Gateway approval check ───────────────────────────
      if (host === "gateway" && !bypassApprovals) {
        const outcome = await checkGatewayApproval({
          command: params.command,
          workdir,
          env,
          paramTimeout: params.timeout,
          paramPty: params.pty,
          sandbox,
          defaultTimeoutSec,
          security,
          ask,
          agentId,
          safeBins,
          defaultsSessionKey: defaults?.sessionKey,
          notifySessionKey,
          scopeKey: defaults?.scopeKey,
          approvalRunningNoticeMs,
          maxOutput,
          pendingMaxOutput,
          warnings,
          runExecProcess,
        });
        if (outcome.action === "handled") {
          return outcome.result;
        }
        // outcome.action === "passed" — fall through to local execution below
      }
      // ── Local / sandbox execution ────────────────────────
      const effectiveTimeout =
        typeof params.timeout === "number" ? params.timeout : defaultTimeoutSec;
      const getWarningText = () => (warnings.length ? `${warnings.join("\n")}\n\n` : "");
      const usePty = params.pty === true && !sandbox;
      const run = await runExecProcess({
        command: params.command,
        workdir,
        env,
        sandbox,
        containerWorkdir,
        usePty,
        warnings,
        maxOutput,
        pendingMaxOutput,
        notifyOnExit,
        scopeKey: defaults?.scopeKey,
        sessionKey: notifySessionKey,
        timeoutSec: effectiveTimeout,
        onUpdate,
      });
      let yielded = false;
      let yieldTimer = null;
      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        if (yielded || run.session.backgrounded) {
          return;
        }
        run.kill();
      };
      if (signal?.aborted) {
        onAbortSignal();
      } else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
      }
      return new Promise((resolve, reject) => {
        const resolveRunning = () =>
          resolve({
            content: [
              {
                type: "text",
                text: `${getWarningText()}Command still running (session ${run.session.id}, pid ${run.session.pid ?? "n/a"}). Use process (list/poll/log/write/kill/clear/remove) for follow-up.`,
              },
            ],
            details: {
              status: "running",
              sessionId: run.session.id,
              pid: run.session.pid ?? undefined,
              startedAt: run.startedAt,
              cwd: run.session.cwd,
              tail: run.session.tail,
            },
          });
        const onYieldNow = () => {
          if (yieldTimer) {
            clearTimeout(yieldTimer);
          }
          if (yielded) {
            return;
          }
          yielded = true;
          markBackgrounded(run.session);
          resolveRunning();
        };
        if (allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            onYieldNow();
          } else {
            yieldTimer = setTimeout(() => {
              if (yielded) {
                return;
              }
              yielded = true;
              markBackgrounded(run.session);
              resolveRunning();
            }, yieldWindow);
          }
        }
        run.promise
          .then((outcome) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            if (outcome.status === "failed") {
              reject(new Error(outcome.reason ?? "Command failed."));
              return;
            }
            resolve({
              content: [
                {
                  type: "text",
                  text: `${getWarningText()}${outcome.aggregated || "(no output)"}`,
                },
              ],
              details: {
                status: "completed",
                exitCode: outcome.exitCode ?? 0,
                durationMs: outcome.durationMs,
                aggregated: outcome.aggregated,
                cwd: run.session.cwd,
              },
            });
          })
          .catch((err) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            reject(err);
          });
      });
    },
  };
}
export const execTool = createExecTool();
