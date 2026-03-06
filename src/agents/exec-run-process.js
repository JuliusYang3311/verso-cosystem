import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { logWarn } from "../logger.js";
import { formatSpawnError, spawnWithFallback } from "../process/spawn-utils.js";
import {
  addSession,
  appendOutput,
  createSessionSlug,
  markExited,
  tail,
} from "./bash-process-registry.js";
import { buildDockerExecArgs, chunkString, killSession } from "./bash-tools.shared.js";
import { buildCursorPositionResponse, stripDsrRequests } from "./pty-dsr.js";
import { getShellConfig, sanitizeBinaryOutput } from "./shell-utils.js";
const DEFAULT_NOTIFY_TAIL_CHARS = 400;
function normalizeNotifyOutput(value) {
  return value.replace(/\s+/g, " ").trim();
}
function maybeNotifyOnExit(session, status) {
  if (!session.backgrounded || !session.notifyOnExit || session.exitNotified) {
    return;
  }
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  session.exitNotified = true;
  const exitLabel = session.exitSignal
    ? `signal ${session.exitSignal}`
    : `code ${session.exitCode ?? 0}`;
  const output = normalizeNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;
  enqueueSystemEvent(summary, { sessionKey });
  requestHeartbeatNow({ reason: `exec:${session.id}:exit` });
}
export async function runExecProcess(opts) {
  const startedAt = Date.now();
  const sessionId = createSessionSlug();
  let child = null;
  let pty = null;
  let stdin;
  if (opts.sandbox) {
    const { child: spawned } = await spawnWithFallback({
      argv: [
        "docker",
        ...buildDockerExecArgs({
          containerName: opts.sandbox.containerName,
          command: opts.command,
          workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
          env: opts.env,
          tty: opts.usePty,
        }),
      ],
      options: {
        cwd: opts.workdir,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
      fallbacks: [
        {
          label: "no-detach",
          options: { detached: false },
        },
        {
          label: "no-detach-ignore-stdin",
          options: { detached: false, stdio: ["ignore", "pipe", "pipe"] },
        },
      ],
      onFallback: (err, fallback) => {
        const errText = formatSpawnError(err);
        const warning = `Warning: spawn failed (${errText}); retrying with ${fallback.label}.`;
        logWarn(`exec: spawn failed (${errText}); retrying with ${fallback.label}.`);
        opts.warnings.push(warning);
      },
    });
    child = spawned;
    stdin = child.stdin;
  } else if (opts.usePty) {
    const { shell, args: shellArgs } = getShellConfig();
    try {
      const ptyModule = await import("@lydell/node-pty");
      const spawnPty = ptyModule.spawn ?? ptyModule.default?.spawn;
      if (!spawnPty) {
        throw new Error("PTY support is unavailable (node-pty spawn not found).");
      }
      pty = spawnPty(shell, [...shellArgs, opts.command], {
        cwd: opts.workdir,
        env: opts.env,
        name: process.env.TERM ?? "xterm-256color",
        cols: 120,
        rows: 30,
      });
      stdin = {
        destroyed: false,
        write: (data, cb) => {
          try {
            pty?.write(data);
            cb?.(null);
          } catch (err) {
            cb?.(err);
          }
        },
        end: () => {
          try {
            const eof = process.platform === "win32" ? "\x1a" : "\x04";
            pty?.write(eof);
          } catch {
            // ignore EOF errors
          }
        },
      };
    } catch (err) {
      const errText = String(err);
      const warning = `Warning: PTY spawn failed (${errText}); retrying without PTY for \`${opts.command}\`.`;
      logWarn(`exec: PTY spawn failed (${errText}); retrying without PTY for "${opts.command}".`);
      opts.warnings.push(warning);
      const { child: spawned } = await spawnWithFallback({
        argv: [shell, ...shellArgs, opts.command],
        options: {
          cwd: opts.workdir,
          env: opts.env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
        fallbacks: [
          {
            label: "no-detach",
            options: { detached: false },
          },
          {
            label: "no-detach-ignore-stdin",
            options: { detached: false, stdio: ["ignore", "pipe", "pipe"] },
          },
        ],
        onFallback: (fallbackErr, fallback) => {
          const fallbackText = formatSpawnError(fallbackErr);
          const fallbackWarning = `Warning: spawn failed (${fallbackText}); retrying with ${fallback.label}.`;
          logWarn(`exec: spawn failed (${fallbackText}); retrying with ${fallback.label}.`);
          opts.warnings.push(fallbackWarning);
        },
      });
      child = spawned;
      stdin = child.stdin;
    }
  } else {
    const { shell, args: shellArgs } = getShellConfig();
    const { child: spawned } = await spawnWithFallback({
      argv: [shell, ...shellArgs, opts.command],
      options: {
        cwd: opts.workdir,
        env: opts.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
      fallbacks: [
        {
          label: "no-detach",
          options: { detached: false },
        },
      ],
      onFallback: (err, fallback) => {
        const errText = formatSpawnError(err);
        const warning = `Warning: spawn failed (${errText}); retrying with ${fallback.label}.`;
        logWarn(`exec: spawn failed (${errText}); retrying with ${fallback.label}.`);
        opts.warnings.push(warning);
      },
    });
    child = spawned;
    stdin = child.stdin;
  }
  const session = {
    id: sessionId,
    command: opts.command,
    scopeKey: opts.scopeKey,
    sessionKey: opts.sessionKey,
    notifyOnExit: opts.notifyOnExit,
    exitNotified: false,
    child: child ?? undefined,
    stdin,
    pid: child?.pid ?? pty?.pid,
    startedAt,
    cwd: opts.workdir,
    maxOutputChars: opts.maxOutput,
    pendingMaxOutputChars: opts.pendingMaxOutput,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "",
    tail: "",
    exited: false,
    exitCode: undefined,
    exitSignal: undefined,
    truncated: false,
    backgrounded: false,
  };
  addSession(session);
  let settled = false;
  let timeoutTimer = null;
  let timeoutFinalizeTimer = null;
  let timedOut = false;
  const timeoutFinalizeMs = 1000;
  let resolveFn = null;
  const settle = (outcome) => {
    if (settled) {
      return;
    }
    settled = true;
    resolveFn?.(outcome);
  };
  const finalizeTimeout = () => {
    if (session.exited) {
      return;
    }
    markExited(session, null, "SIGKILL", "failed");
    maybeNotifyOnExit(session, "failed");
    const aggregated = session.aggregated.trim();
    const reason = `Command timed out after ${opts.timeoutSec} seconds`;
    settle({
      status: "failed",
      exitCode: null,
      exitSignal: "SIGKILL",
      durationMs: Date.now() - startedAt,
      aggregated,
      timedOut: true,
      reason: aggregated ? `${aggregated}\n\n${reason}` : reason,
    });
  };
  const onTimeout = () => {
    timedOut = true;
    killSession(session);
    if (!timeoutFinalizeTimer) {
      timeoutFinalizeTimer = setTimeout(() => {
        finalizeTimeout();
      }, timeoutFinalizeMs);
    }
  };
  if (opts.timeoutSec > 0) {
    timeoutTimer = setTimeout(() => {
      onTimeout();
    }, opts.timeoutSec * 1000);
  }
  const emitUpdate = () => {
    if (!opts.onUpdate) {
      return;
    }
    const tailText = session.tail || session.aggregated;
    const warningText = opts.warnings.length ? `${opts.warnings.join("\n")}\n\n` : "";
    opts.onUpdate({
      content: [{ type: "text", text: warningText + (tailText || "") }],
      details: {
        status: "running",
        sessionId,
        pid: session.pid ?? undefined,
        startedAt,
        cwd: session.cwd,
        tail: session.tail,
      },
    });
  };
  const handleStdout = (data) => {
    const str = sanitizeBinaryOutput(data.toString());
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stdout", chunk);
      emitUpdate();
    }
  };
  const handleStderr = (data) => {
    const str = sanitizeBinaryOutput(data.toString());
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stderr", chunk);
      emitUpdate();
    }
  };
  if (pty) {
    const cursorResponse = buildCursorPositionResponse();
    pty.onData((data) => {
      const raw = data.toString();
      const { cleaned, requests } = stripDsrRequests(raw);
      if (requests > 0) {
        for (let i = 0; i < requests; i += 1) {
          pty.write(cursorResponse);
        }
      }
      handleStdout(cleaned);
    });
  } else if (child) {
    child.stdout.on("data", handleStdout);
    child.stderr.on("data", handleStderr);
  }
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
    const handleExit = (code, exitSignal) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (timeoutFinalizeTimer) {
        clearTimeout(timeoutFinalizeTimer);
      }
      const durationMs = Date.now() - startedAt;
      const wasSignal = exitSignal != null;
      const isSuccess = code === 0 && !wasSignal && !timedOut;
      const status = isSuccess ? "completed" : "failed";
      markExited(session, code, exitSignal, status);
      maybeNotifyOnExit(session, status);
      if (!session.child && session.stdin) {
        session.stdin.destroyed = true;
      }
      if (settled) {
        return;
      }
      const aggregated = session.aggregated.trim();
      if (!isSuccess) {
        const reason = timedOut
          ? `Command timed out after ${opts.timeoutSec} seconds`
          : wasSignal && exitSignal
            ? `Command aborted by signal ${exitSignal}`
            : code === null
              ? "Command aborted before exit code was captured"
              : `Command exited with code ${code}`;
        const message = aggregated ? `${aggregated}\n\n${reason}` : reason;
        settle({
          status: "failed",
          exitCode: code ?? null,
          exitSignal: exitSignal ?? null,
          durationMs,
          aggregated,
          timedOut,
          reason: message,
        });
        return;
      }
      settle({
        status: "completed",
        exitCode: code ?? 0,
        exitSignal: exitSignal ?? null,
        durationMs,
        aggregated,
        timedOut: false,
      });
    };
    if (pty) {
      pty.onExit((event) => {
        const rawSignal = event.signal ?? null;
        const normalizedSignal = rawSignal === 0 ? null : rawSignal;
        handleExit(event.exitCode ?? null, normalizedSignal);
      });
    } else if (child) {
      child.once("close", (code, exitSignal) => {
        handleExit(code, exitSignal);
      });
      child.once("error", (err) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (timeoutFinalizeTimer) {
          clearTimeout(timeoutFinalizeTimer);
        }
        markExited(session, null, null, "failed");
        maybeNotifyOnExit(session, "failed");
        const aggregated = session.aggregated.trim();
        const message = aggregated ? `${aggregated}\n\n${String(err)}` : String(err);
        settle({
          status: "failed",
          exitCode: null,
          exitSignal: null,
          durationMs: Date.now() - startedAt,
          aggregated,
          timedOut,
          reason: message,
        });
      });
    }
  });
  return {
    session,
    startedAt,
    pid: session.pid ?? undefined,
    promise,
    kill: () => killSession(session),
  };
}
