import crypto from "node:crypto";
import {
  addAllowlistEntry,
  evaluateShellAllowlist,
  maxAsk,
  minSecurity,
  recordAllowlistUse,
  requiresExecApproval,
  resolveExecApprovals,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { markBackgrounded, tail } from "./bash-process-registry.js";
import { applyPathPrepend } from "./exec-env.js";
import { callGatewayTool } from "./tools/gateway.js";
import { listNodes, resolveNodeIdFromList } from "./tools/nodes-utils.js";
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = 130_000;
const APPROVAL_SLUG_LENGTH = 8;
const DEFAULT_NOTIFY_TAIL_CHARS = 400;
function createApprovalSlug(id) {
  return id.slice(0, APPROVAL_SLUG_LENGTH);
}
function normalizeNotifyOutput(value) {
  return value.replace(/\s+/g, " ").trim();
}
function emitExecSystemEvent(text, opts) {
  const sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  enqueueSystemEvent(text, { sessionKey, contextKey: opts.contextKey });
  requestHeartbeatNow({ reason: "exec-event" });
}
export async function executeOnNode(params) {
  const { security, ask, agentId, workdir, env, warnings } = params;
  const approvals = resolveExecApprovals(agentId, { security, ask });
  const hostSecurity = minSecurity(security, approvals.agent.security);
  const hostAsk = maxAsk(ask, approvals.agent.ask);
  const askFallback = approvals.agent.askFallback;
  if (hostSecurity === "deny") {
    throw new Error("exec denied: host=node security=deny");
  }
  const boundNode = params.boundNode;
  const requestedNode = params.requestedNode;
  if (boundNode && requestedNode && boundNode !== requestedNode) {
    throw new Error(`exec node not allowed (bound to ${boundNode})`);
  }
  const nodeQuery = boundNode || requestedNode;
  const nodes = await listNodes({});
  if (nodes.length === 0) {
    throw new Error(
      "exec host=node requires a paired node (none available). This requires a companion app or node host.",
    );
  }
  let nodeId;
  try {
    nodeId = resolveNodeIdFromList(nodes, nodeQuery, !nodeQuery);
  } catch (err) {
    if (!nodeQuery && String(err).includes("node required")) {
      throw new Error(
        "exec host=node requires a node id when multiple nodes are available (set tools.exec.node or exec.node).",
        { cause: err },
      );
    }
    throw err;
  }
  const nodeInfo = nodes.find((entry) => entry.nodeId === nodeId);
  const supportsSystemRun = Array.isArray(nodeInfo?.commands)
    ? nodeInfo?.commands?.includes("system.run")
    : false;
  if (!supportsSystemRun) {
    throw new Error(
      "exec host=node requires a node that supports system.run (companion app or node host).",
    );
  }
  const argv = buildNodeShellCommand(params.command, nodeInfo?.platform);
  const nodeEnv = params.paramsEnv ? { ...params.paramsEnv } : undefined;
  if (nodeEnv) {
    applyPathPrepend(nodeEnv, params.defaultPathPrepend, { requireExisting: true });
  }
  const baseAllowlistEval = evaluateShellAllowlist({
    command: params.command,
    allowlist: [],
    safeBins: new Set(),
    cwd: workdir,
    env,
    platform: nodeInfo?.platform,
  });
  let analysisOk = baseAllowlistEval.analysisOk;
  let allowlistSatisfied = false;
  if (hostAsk === "on-miss" && hostSecurity === "allowlist" && analysisOk) {
    try {
      const approvalsSnapshot = await callGatewayTool(
        "exec.approvals.node.get",
        { timeoutMs: 10_000 },
        { nodeId },
      );
      const approvalsFile =
        approvalsSnapshot && typeof approvalsSnapshot === "object"
          ? approvalsSnapshot.file
          : undefined;
      if (approvalsFile && typeof approvalsFile === "object") {
        const resolved = resolveExecApprovalsFromFile({
          file: approvalsFile,
          agentId,
          overrides: { security: "allowlist" },
        });
        // Allowlist-only precheck; safe bins are node-local and may diverge.
        const allowlistEval = evaluateShellAllowlist({
          command: params.command,
          allowlist: resolved.allowlist,
          safeBins: new Set(),
          cwd: workdir,
          env,
          platform: nodeInfo?.platform,
        });
        allowlistSatisfied = allowlistEval.allowlistSatisfied;
        analysisOk = allowlistEval.analysisOk;
      }
    } catch {
      // Fall back to requiring approval if node approvals cannot be fetched.
    }
  }
  const requiresAsk = requiresExecApproval({
    ask: hostAsk,
    security: hostSecurity,
    analysisOk,
    allowlistSatisfied,
  });
  const commandText = params.command;
  const invokeTimeoutMs = Math.max(
    10_000,
    (typeof params.paramTimeout === "number" ? params.paramTimeout : params.defaultTimeoutSec) *
      1000 +
      5_000,
  );
  const buildInvokeParams = (approvedByAsk, approvalDecision, runId) => ({
    nodeId,
    command: "system.run",
    params: {
      command: argv,
      rawCommand: params.command,
      cwd: workdir,
      env: nodeEnv,
      timeoutMs: typeof params.paramTimeout === "number" ? params.paramTimeout * 1000 : undefined,
      agentId,
      sessionKey: params.defaultsSessionKey,
      approved: approvedByAsk,
      approvalDecision: approvalDecision ?? undefined,
      runId: runId ?? undefined,
    },
    idempotencyKey: crypto.randomUUID(),
  });
  if (requiresAsk) {
    const approvalId = crypto.randomUUID();
    const approvalSlug = createApprovalSlug(approvalId);
    const expiresAtMs = Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
    const contextKey = `exec:${approvalId}`;
    const noticeSeconds = Math.max(1, Math.round(params.approvalRunningNoticeMs / 1000));
    const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";
    void (async () => {
      let decision = null;
      try {
        const decisionResult = await callGatewayTool(
          "exec.approval.request",
          { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
          {
            id: approvalId,
            command: commandText,
            cwd: workdir,
            host: "node",
            security: hostSecurity,
            ask: hostAsk,
            agentId,
            resolvedPath: undefined,
            sessionKey: params.defaultsSessionKey,
            timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
          },
        );
        const decisionValue =
          decisionResult && typeof decisionResult === "object"
            ? decisionResult.decision
            : undefined;
        decision = typeof decisionValue === "string" ? decisionValue : null;
      } catch {
        emitExecSystemEvent(
          `Exec denied (node=${nodeId} id=${approvalId}, approval-request-failed): ${commandText}`,
          { sessionKey: params.notifySessionKey, contextKey },
        );
        return;
      }
      let approvedByAsk = false;
      let approvalDecision = null;
      let deniedReason = null;
      if (decision === "deny") {
        deniedReason = "user-denied";
      } else if (!decision) {
        if (askFallback === "full") {
          approvedByAsk = true;
          approvalDecision = "allow-once";
        } else if (askFallback === "allowlist") {
          // Defer allowlist enforcement to the node host.
        } else {
          deniedReason = "approval-timeout";
        }
      } else if (decision === "allow-once") {
        approvedByAsk = true;
        approvalDecision = "allow-once";
      } else if (decision === "allow-always") {
        approvedByAsk = true;
        approvalDecision = "allow-always";
      }
      if (deniedReason) {
        emitExecSystemEvent(
          `Exec denied (node=${nodeId} id=${approvalId}, ${deniedReason}): ${commandText}`,
          { sessionKey: params.notifySessionKey, contextKey },
        );
        return;
      }
      let runningTimer = null;
      if (params.approvalRunningNoticeMs > 0) {
        runningTimer = setTimeout(() => {
          emitExecSystemEvent(
            `Exec running (node=${nodeId} id=${approvalId}, >${noticeSeconds}s): ${commandText}`,
            { sessionKey: params.notifySessionKey, contextKey },
          );
        }, params.approvalRunningNoticeMs);
      }
      try {
        await callGatewayTool(
          "node.invoke",
          { timeoutMs: invokeTimeoutMs },
          buildInvokeParams(approvedByAsk, approvalDecision, approvalId),
        );
      } catch {
        emitExecSystemEvent(
          `Exec denied (node=${nodeId} id=${approvalId}, invoke-failed): ${commandText}`,
          { sessionKey: params.notifySessionKey, contextKey },
        );
      } finally {
        if (runningTimer) {
          clearTimeout(runningTimer);
        }
      }
    })();
    return {
      content: [
        {
          type: "text",
          text:
            `${warningText}Approval required (id ${approvalSlug}). ` +
            "Approve to run; updates will arrive after completion.",
        },
      ],
      details: {
        status: "approval-pending",
        approvalId,
        approvalSlug,
        expiresAtMs,
        host: "node",
        command: commandText,
        cwd: workdir,
        nodeId,
      },
    };
  }
  const startedAt = Date.now();
  const raw = await callGatewayTool(
    "node.invoke",
    { timeoutMs: invokeTimeoutMs },
    buildInvokeParams(false, null),
  );
  const payload = raw && typeof raw === "object" ? raw.payload : undefined;
  const payloadObj = payload && typeof payload === "object" ? payload : {};
  const stdout = typeof payloadObj.stdout === "string" ? payloadObj.stdout : "";
  const stderr = typeof payloadObj.stderr === "string" ? payloadObj.stderr : "";
  const errorText = typeof payloadObj.error === "string" ? payloadObj.error : "";
  const success = typeof payloadObj.success === "boolean" ? payloadObj.success : false;
  const exitCode = typeof payloadObj.exitCode === "number" ? payloadObj.exitCode : null;
  return {
    content: [
      {
        type: "text",
        text: stdout || stderr || errorText || "",
      },
    ],
    details: {
      status: success ? "completed" : "failed",
      exitCode,
      durationMs: Date.now() - startedAt,
      aggregated: [stdout, stderr, errorText].filter(Boolean).join("\n"),
      cwd: workdir,
    },
  };
}
export async function checkGatewayApproval(params) {
  const { security, ask, agentId, workdir, env, warnings } = params;
  const approvals = resolveExecApprovals(agentId, { security, ask });
  const hostSecurity = minSecurity(security, approvals.agent.security);
  const hostAsk = maxAsk(ask, approvals.agent.ask);
  const askFallback = approvals.agent.askFallback;
  if (hostSecurity === "deny") {
    throw new Error("exec denied: host=gateway security=deny");
  }
  const allowlistEval = evaluateShellAllowlist({
    command: params.command,
    allowlist: approvals.allowlist,
    safeBins: params.safeBins,
    cwd: workdir,
    env,
    platform: process.platform,
  });
  const allowlistMatches = allowlistEval.allowlistMatches;
  const analysisOk = allowlistEval.analysisOk;
  const allowlistSatisfied =
    hostSecurity === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
  const requiresAsk = requiresExecApproval({
    ask: hostAsk,
    security: hostSecurity,
    analysisOk,
    allowlistSatisfied,
  });
  if (requiresAsk) {
    const approvalId = crypto.randomUUID();
    const approvalSlug = createApprovalSlug(approvalId);
    const expiresAtMs = Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
    const contextKey = `exec:${approvalId}`;
    const resolvedPath = allowlistEval.segments[0]?.resolution?.resolvedPath;
    const noticeSeconds = Math.max(1, Math.round(params.approvalRunningNoticeMs / 1000));
    const commandText = params.command;
    const effectiveTimeout =
      typeof params.paramTimeout === "number" ? params.paramTimeout : params.defaultTimeoutSec;
    const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";
    void (async () => {
      let decision = null;
      try {
        const decisionResult = await callGatewayTool(
          "exec.approval.request",
          { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
          {
            id: approvalId,
            command: commandText,
            cwd: workdir,
            host: "gateway",
            security: hostSecurity,
            ask: hostAsk,
            agentId,
            resolvedPath,
            sessionKey: params.defaultsSessionKey,
            timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
          },
        );
        const decisionValue =
          decisionResult && typeof decisionResult === "object"
            ? decisionResult.decision
            : undefined;
        decision = typeof decisionValue === "string" ? decisionValue : null;
      } catch {
        emitExecSystemEvent(
          `Exec denied (gateway id=${approvalId}, approval-request-failed): ${commandText}`,
          { sessionKey: params.notifySessionKey, contextKey },
        );
        return;
      }
      let approvedByAsk = false;
      let deniedReason = null;
      if (decision === "deny") {
        deniedReason = "user-denied";
      } else if (!decision) {
        if (askFallback === "full") {
          approvedByAsk = true;
        } else if (askFallback === "allowlist") {
          if (!analysisOk || !allowlistSatisfied) {
            deniedReason = "approval-timeout (allowlist-miss)";
          } else {
            approvedByAsk = true;
          }
        } else {
          deniedReason = "approval-timeout";
        }
      } else if (decision === "allow-once") {
        approvedByAsk = true;
      } else if (decision === "allow-always") {
        approvedByAsk = true;
        if (hostSecurity === "allowlist") {
          for (const segment of allowlistEval.segments) {
            const pattern = segment.resolution?.resolvedPath ?? "";
            if (pattern) {
              addAllowlistEntry(approvals.file, agentId, pattern);
            }
          }
        }
      }
      if (hostSecurity === "allowlist" && (!analysisOk || !allowlistSatisfied) && !approvedByAsk) {
        deniedReason = deniedReason ?? "allowlist-miss";
      }
      if (deniedReason) {
        emitExecSystemEvent(
          `Exec denied (gateway id=${approvalId}, ${deniedReason}): ${commandText}`,
          { sessionKey: params.notifySessionKey, contextKey },
        );
        return;
      }
      if (allowlistMatches.length > 0) {
        const seen = new Set();
        for (const match of allowlistMatches) {
          if (seen.has(match.pattern)) {
            continue;
          }
          seen.add(match.pattern);
          recordAllowlistUse(
            approvals.file,
            agentId,
            match,
            commandText,
            resolvedPath ?? undefined,
          );
        }
      }
      let run = null;
      try {
        run = await params.runExecProcess({
          command: commandText,
          workdir,
          env,
          sandbox: undefined,
          containerWorkdir: null,
          usePty: params.paramPty === true && !params.sandbox,
          warnings,
          maxOutput: params.maxOutput,
          pendingMaxOutput: params.pendingMaxOutput,
          notifyOnExit: false,
          scopeKey: params.scopeKey,
          sessionKey: params.notifySessionKey,
          timeoutSec: effectiveTimeout,
        });
      } catch {
        emitExecSystemEvent(
          `Exec denied (gateway id=${approvalId}, spawn-failed): ${commandText}`,
          { sessionKey: params.notifySessionKey, contextKey },
        );
        return;
      }
      markBackgrounded(run.session);
      let runningTimer = null;
      if (params.approvalRunningNoticeMs > 0) {
        runningTimer = setTimeout(() => {
          emitExecSystemEvent(
            `Exec running (gateway id=${approvalId}, session=${run?.session.id}, >${noticeSeconds}s): ${commandText}`,
            { sessionKey: params.notifySessionKey, contextKey },
          );
        }, params.approvalRunningNoticeMs);
      }
      const outcome = await run.promise;
      if (runningTimer) {
        clearTimeout(runningTimer);
      }
      const output = normalizeNotifyOutput(
        tail(outcome.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
      );
      const exitLabel = outcome.timedOut ? "timeout" : `code ${outcome.exitCode ?? "?"}`;
      const summary = output
        ? `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})\n${output}`
        : `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})`;
      emitExecSystemEvent(summary, { sessionKey: params.notifySessionKey, contextKey });
    })();
    return {
      action: "handled",
      result: {
        content: [
          {
            type: "text",
            text:
              `${warningText}Approval required (id ${approvalSlug}). ` +
              "Approve to run; updates will arrive after completion.",
          },
        ],
        details: {
          status: "approval-pending",
          approvalId,
          approvalSlug,
          expiresAtMs,
          host: "gateway",
          command: params.command,
          cwd: workdir,
        },
      },
    };
  }
  if (hostSecurity === "allowlist" && (!analysisOk || !allowlistSatisfied)) {
    throw new Error("exec denied: allowlist miss");
  }
  if (allowlistMatches.length > 0) {
    const seen = new Set();
    for (const match of allowlistMatches) {
      if (seen.has(match.pattern)) {
        continue;
      }
      seen.add(match.pattern);
      recordAllowlistUse(
        approvals.file,
        agentId,
        match,
        params.command,
        allowlistEval.segments[0]?.resolution?.resolvedPath,
      );
    }
  }
  return { action: "passed" };
}
