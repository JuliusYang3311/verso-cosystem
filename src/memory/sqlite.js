import { createRequire } from "node:module";
import { installProcessWarningFilter } from "../infra/warning-filter.js";
const require = createRequire(import.meta.url);
export function requireNodeSqlite() {
  installProcessWarningFilter();
  return require("node:sqlite");
}
