import { clearActiveProgressLine } from "./terminal/progress-line.js";
import { restoreTerminalState } from "./terminal/restore.js";
export const defaultRuntime = {
  log: (...args) => {
    clearActiveProgressLine();
    console.log(...args);
  },
  error: (...args) => {
    clearActiveProgressLine();
    console.error(...args);
  },
  exit: (code) => {
    restoreTerminalState("runtime exit");
    process.exit(code);
    throw new Error("unreachable"); // satisfies tests when mocked
  },
};
