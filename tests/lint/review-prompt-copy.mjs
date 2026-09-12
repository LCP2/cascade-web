// CAS-969 AC5: app_template.html must never carry a custom "rate us" modal, or any string offering
// something in exchange for a review — App Review Guidelines Section 3 (manipulated/incentivised reviews)
// and 3.2.2(x) (forcing a review to reach functionality) name both as grounds for expulsion from the
// Developer Program, not just rejection. The real prompt is Apple's own SKStoreReviewController, which
// this app never styles or wraps in copy of its own — see maybeRequestReview() in app_template.html.
//
// Grep-level, not an HTML parser: each pattern below is a phrase this codebase must never contain,
// case-insensitive. A match fails the run.
//
// Run with `node tests/lint/review-prompt-copy.mjs`. Exits non-zero on any violation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "..", "..", "app_template.html");

// Each entry: a human label, and the regex it must never match anywhere in the file.
const FORBIDDEN = [
  { label: "custom rating modal reference", re: /rate[\s-]?us/i },
  { label: "custom rating modal reference", re: /rate[\s-]?this[\s-]?app/i },
  { label: "star-rating request copy", re: /enjoying\s+cascade\??\s*(rate|review)/i },
  { label: "incentive offered for a review", re: /(free\s+month|free\s+trial|credit|unlock(?:ed)?[^.\n]{0,40})[^.\n]{0,60}(review|rating)/i },
  { label: "incentive offered for a review (reverse order)", re: /(review|rating)[^.\n]{0,60}(free\s+month|free\s+trial|\bcredit\b|unlock)/i },
];

function run() {
  const src = readFileSync(TEMPLATE_PATH, "utf8");
  const lines = src.split("\n");
  const violations = [];

  lines.forEach((line, i) => {
    for (const { label, re } of FORBIDDEN) {
      if (re.test(line)) violations.push({ line: i + 1, label, text: line.trim() });
    }
  });

  for (const v of violations) {
    console.error(`[REVIEW-PROMPT-COPY] app_template.html:${v.line} — ${v.label}: ${v.text}`);
  }
  console.log(`\nreview-prompt-copy: ${violations.length} violation(s)`);
  if (violations.length) process.exit(1);
}

run();
