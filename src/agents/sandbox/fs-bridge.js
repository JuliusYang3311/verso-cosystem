import path from "node:path";
import { resolveSandboxPath } from "../sandbox-paths.js";
import { execDockerRaw } from "./docker.js";
export function createSandboxFsBridge(params) {
  return new SandboxFsBridgeImpl(params.sandbox);
}
class SandboxFsBridgeImpl {
  sandbox;
  constructor(sandbox) {
    this.sandbox = sandbox;
  }
  resolvePath(params) {
    return resolveSandboxFsPath({
      sandbox: this.sandbox,
      filePath: params.filePath,
      cwd: params.cwd,
    });
  }
  async readFile(params) {
    const target = this.resolvePath(params);
    const result = await this.runCommand('set -eu; cat -- "$1"', {
      args: [target.containerPath],
      signal: params.signal,
    });
    return Buffer.from(result.stdout);
  }
  async writeFile(params) {
    this.ensureWriteAccess("write files");
    const target = this.resolvePath(params);
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    const script =
      params.mkdir === false
        ? 'set -eu; cat >"$1"'
        : 'set -eu; dir=$(dirname -- "$1"); if [ "$dir" != "." ]; then mkdir -p -- "$dir"; fi; cat >"$1"';
    await this.runCommand(script, {
      args: [target.containerPath],
      stdin: buffer,
      signal: params.signal,
    });
  }
  async mkdirp(params) {
    this.ensureWriteAccess("create directories");
    const target = this.resolvePath(params);
    await this.runCommand('set -eu; mkdir -p -- "$1"', {
      args: [target.containerPath],
      signal: params.signal,
    });
  }
  async remove(params) {
    this.ensureWriteAccess("remove files");
    const target = this.resolvePath(params);
    const flags = [params.force === false ? "" : "-f", params.recursive ? "-r" : ""].filter(
      Boolean,
    );
    const rmCommand = flags.length > 0 ? `rm ${flags.join(" ")}` : "rm";
    await this.runCommand(`set -eu; ${rmCommand} -- "$1"`, {
      args: [target.containerPath],
      signal: params.signal,
    });
  }
  async rename(params) {
    this.ensureWriteAccess("rename files");
    const from = this.resolvePath({ filePath: params.from, cwd: params.cwd });
    const to = this.resolvePath({ filePath: params.to, cwd: params.cwd });
    await this.runCommand(
      'set -eu; dir=$(dirname -- "$2"); if [ "$dir" != "." ]; then mkdir -p -- "$dir"; fi; mv -- "$1" "$2"',
      {
        args: [from.containerPath, to.containerPath],
        signal: params.signal,
      },
    );
  }
  async stat(params) {
    const target = this.resolvePath(params);
    const result = await this.runCommand('set -eu; stat -c "%F|%s|%Y" -- "$1"', {
      args: [target.containerPath],
      signal: params.signal,
      allowFailure: true,
    });
    if (result.code !== 0) {
      const stderr = result.stderr;
      if (stderr.includes("No such file or directory")) {
        return null;
      }
      const message = stderr.trim() || `stat failed with code ${result.code}`;
      throw new Error(`stat failed for ${target.containerPath}: ${message}`);
    }
    const text = result.stdout.trim();
    const [typeRaw, sizeRaw, mtimeRaw] = text.split("|");
    const size = Number.parseInt(sizeRaw ?? "0", 10);
    const mtime = Number.parseInt(mtimeRaw ?? "0", 10) * 1000;
    return {
      type: coerceStatType(typeRaw),
      size: Number.isFinite(size) ? size : 0,
      mtimeMs: Number.isFinite(mtime) ? mtime : 0,
    };
  }
  async runCommand(script, options = {}) {
    const dockerArgs = [
      "exec",
      "-i",
      this.sandbox.containerName,
      "sh",
      "-c",
      script,
      "moltbot-sandbox-fs",
    ];
    if (options.args?.length) {
      dockerArgs.push(...options.args);
    }
    return execDockerRaw(dockerArgs, {
      allowFailure: false,
      input: options.stdin ? options.stdin.toString() : undefined,
      signal: options.signal,
    });
  }
  ensureWriteAccess(action) {
    if (!allowsWrites(this.sandbox.workspaceAccess)) {
      throw new Error(
        `Sandbox workspace (${this.sandbox.workspaceAccess}) does not allow ${action}.`,
      );
    }
  }
}
function allowsWrites(access) {
  return access === "rw";
}
function resolveSandboxFsPath(params) {
  const root = params.sandbox.workspaceDir;
  const cwd = params.cwd ?? root;
  const { resolved, relative } = resolveSandboxPath({
    filePath: params.filePath,
    cwd,
    root,
  });
  const normalizedRelative = relative
    ? relative.split(path.sep).filter(Boolean).join(path.posix.sep)
    : "";
  const containerPath = normalizedRelative
    ? path.posix.join(params.sandbox.containerWorkdir, normalizedRelative)
    : params.sandbox.containerWorkdir;
  return {
    hostPath: resolved,
    relativePath: normalizedRelative,
    containerPath,
  };
}
function coerceStatType(typeRaw) {
  if (!typeRaw) {
    return "other";
  }
  const normalized = typeRaw.trim().toLowerCase();
  if (normalized.includes("directory")) {
    return "directory";
  }
  if (normalized.includes("file")) {
    return "file";
  }
  return "other";
}
