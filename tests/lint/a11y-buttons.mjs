// CAS-960: every <button> in app_template.html needs an accessible name — either a non-empty aria-label
// attribute or non-whitespace text content between its tags. Icon-only buttons (an <svg>, a glyph span
// marked aria-hidden, or nothing) fail this unless they carry aria-label.
//
// Grep-level, not an HTML parser (per the ticket): matches <button ...>...</button> pairs across the whole
// file (buttons never nest here), strips child tags from the inner content, and requires either a non-empty
// aria-label="..." attribute or leftover non-whitespace text.
//
// Run with `node tests/lint/a11y-buttons.mjs`. Exits non-zero on any violation. Appends its result to
// qa-a11y-report.txt alongside the contrast check and the axe scan (CAS-960).

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const TEMPLATE_PATH = path.join(REPO_ROOT, "app_template.html");
const REPORT_PATH = path.join(REPO_ROOT, "qa-a11y-report.txt");

const BUTTON_RE = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
const ARIA_LABEL_RE = /aria-label\s*=\s*"([^"]*)"/;

function lineOf(html, index) {
  return html.slice(0, index).split("\n").length;
}

function run() {
  const html = readFileSync(TEMPLATE_PATH, "utf8");

  const violations = [];
  let m;
  while ((m = BUTTON_RE.exec(html))) {
    const [full, attrs, inner] = m;
    const labelMatch = attrs.match(ARIA_LABEL_RE);
    const hasLabel = labelMatch && labelMatch[1].trim().length > 0;
    if (hasLabel) continue;

    const text = inner.replace(/<[^>]*>/g, "").trim();
    if (text.length > 0) continue;

    violations.push({ line: lineOf(html, m.index), text: full.slice(0, 120).replace(/\s+/g, " ") });
  }

  const lines = ["CAS-960 button accessible-name report — every <button> needs an aria-label or text content.\n"];
  for (const v of violations) {
    const msg = `[A11Y-BUTTON] app_template.html:${v.line} — <button> has neither aria-label nor text content: ${v.text}`;
    console.error(msg);
    lines.push(msg);
  }
  lines.push(`\na11y-buttons: ${violations.length} violation(s)`);
  console.log(`\na11y-buttons: ${violations.length} violation(s)`);
  appendFileSync(REPORT_PATH, lines.join("\n") + "\n\n");

  if (violations.length) process.exit(1);
}

run();
