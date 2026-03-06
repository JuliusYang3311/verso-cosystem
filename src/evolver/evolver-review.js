/**
 * evolver-review.ts
 * Shared protocol for daemon ↔ main session review communication.
 * The daemon writes a pending review file; the main session reads it,
 * shows it to the user, and writes back a decision.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
const REVIEW_FILENAME = "evolver-pending-review.json";
function resolveReviewPath() {
  const logsDir = path.join(resolveStateDir(), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  return path.join(logsDir, REVIEW_FILENAME);
}
/** Write a pending review (daemon side). */
export function writePendingReview(review) {
  const data = { ...review, decision: null };
  fs.writeFileSync(resolveReviewPath(), JSON.stringify(data, null, 2) + "\n");
}
/** Read the current pending review, or null if none exists. */
export function readPendingReview() {
  try {
    const raw = fs.readFileSync(resolveReviewPath(), "utf-8").trim();
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
/** Write a decision to the pending review (main session side). */
export function decidePendingReview(decision) {
  const review = readPendingReview();
  if (!review) {
    return null;
  }
  review.decision = decision;
  review.decidedAt = new Date().toISOString();
  fs.writeFileSync(resolveReviewPath(), JSON.stringify(review, null, 2) + "\n");
  return review;
}
/** Clear the pending review file (daemon side, after processing decision). */
export function clearPendingReview() {
  try {
    fs.unlinkSync(resolveReviewPath());
  } catch {
    // ignore
  }
}
