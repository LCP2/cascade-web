// CAS-945: static XSS-sink lint over app_template.html's template literals. esc() only neutralises `<`,
// which is adequate for a text node but not for an HTML attribute — a stray `"` in an esc()'d value lands
// inside an attribute and closes it early, opening an event-handler injection. escA() is the attribute-safe
// escaper; a ${esc(...)} interpolation that lands inside a double-quoted attribute is always the wrong call.
//
// Grep-level, not an HTML parser (per the ticket): for each `${esc(` on a line, walk the line's prefix up
// to that point counting `"` characters. An odd count means the interpolation sits inside a currently-open
// double-quoted string; if that quote was itself opened right after an `=` (i.e. `attr="`), it's an
// attribute value, not free text, and the site is flagged. escA( is not `esc(` followed by `(`, so escA
// call sites never match.
//
// Run with `node tests/lint/xss-sinks.mjs`. Exits non-zero on any violation.
//
// A violation is accepted as a deliberate exception with an inline comment naming the rule, placed either
// on the offending line or the line above it: /* xss-sinks-ignore: ATTR-ESC — reason */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "..", "..", "app_template.html");

const ESC_CALL_RE = /\$\{esc\(/g;

function quoteStateBefore(prefix) {
  // Returns whether position `prefix.length` sits inside a double-quoted string opened right after `=`
  // (an attribute value), by toggling on every unescaped `"` seen so far on the line.
  let inside = false;
  let attrOpen = false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== "\"") continue;
    if (prefix[i - 1] === "\\") continue; // escaped quote inside a JS string literal, not an HTML boundary
    if (!inside) {
      let j = i - 1;
      while (j >= 0 && prefix[j] === " ") j--;
      attrOpen = j >= 0 && prefix[j] === "=";
      inside = true;
    } else {
      inside = false;
      attrOpen = false;
    }
  }
  return { inside, attrOpen };
}

function isIgnored(lines, lineIdx) {
  const re = /xss-sinks-ignore:\s*ATTR-ESC\b/;
  return re.test(lines[lineIdx]) || (lineIdx > 0 && re.test(lines[lineIdx - 1]));
}

function run() {
  const html = readFileSync(TEMPLATE_PATH, "utf8");
  const lines = html.split("\n");

  const violations = [];
  const ignored = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    ESC_CALL_RE.lastIndex = 0;
    let m;
    while ((m = ESC_CALL_RE.exec(line))) {
      const prefix = line.slice(0, m.index);
      const { inside, attrOpen } = quoteStateBefore(prefix);
      if (inside && attrOpen) {
        const entry = { line: i + 1, text: line.trim() };
        (isIgnored(lines, i) ? ignored : violations).push(entry);
      }
    }
  }

  for (const v of violations) {
    console.error(`[ATTR-ESC] app_template.html:${v.line} — esc( used inside an HTML attribute — use escA() (or safeUrl() for a URL) instead: ${v.text}`);
  }
  for (const v of ignored) {
    console.log(`[ATTR-ESC-ignored] app_template.html:${v.line} — ${v.text}`);
  }

  console.log(`\nxss-sinks: ${violations.length} violation(s), ${ignored.length} ignored`);

  if (violations.length) process.exit(1);
}

run();
