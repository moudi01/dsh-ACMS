import { assert, text } from "./util.js";

const categories = new Set(["product-defect", "environment", "contract-conflict", "evidence"]);

export function reworkDetails(value) {
  if (value == null) return null;
  assert(typeof value === "object" && categories.has(value.category), "INVALID_REWORK", "Choose a supported rework category");
  assert(Array.isArray(value.affectedEntrypoints) && value.affectedEntrypoints.length <= 30,
    "INVALID_REWORK", "List the entry points affected by the same issue");
  return {
    category: value.category,
    evidence: text(value.evidence, "rework.evidence", 4000),
    scope: text(value.scope, "rework.scope", 4000),
    affectedEntrypoints: value.affectedEntrypoints.map(item => text(item, "rework.affectedEntrypoints", 500)),
    source: "explicit",
  };
}
