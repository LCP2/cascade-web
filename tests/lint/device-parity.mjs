// CAS-554: static device-parity lint over app_template.html's <style> block. iOS Safari and the Capacitor
// WKWebView run the same WebKit build, so a bug that shows in the app but not in device Safari is (almost)
// always one of three statically-detectable things — see the ticket for the why behind each rule:
//   R1 — a bare `vh` length with no dvh/svh/-webkit-fill-available fallback in the same rule.
//   R2 — position:fixed/sticky pinned to top:0 or bottom:0 with no matching env(safe-area-inset-*).
//   R3 — position:sticky whose CSS-textual ancestor (a descendant-combinator selector) is transformed/
//        filtered/etc, which can steal its containing block. A purely textual walk can't see real DOM
//        nesting for a bare class selector, so those print a WARNING (not a failure) instead of guessing.
// Deliberately not a Playwright spec (see ticket): a grep-level text check can't flake and isn't slowed by
// a browser. Run with `node tests/lint/device-parity.mjs`. Exits non-zero on any unignored violation.
//
// A violation is accepted as a deliberate exception with an inline comment naming the rule, placed either
// directly above the rule or inside its declaration block:  /* device-parity-ignore: R1 — reason */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "..", "..", "app_template.html");

function blankComments(text) {
  // Replace comment interiors with spaces (newlines kept) so line numbers and character offsets stay
  // identical between the "clean" text used for structural parsing and the original used for ignore-comment
  // and offending-declaration lookups.
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < text.length) { out += "  "; i += 2; }
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

function extractStyleBlock(html) {
  const open = html.indexOf("<style>");
  const close = html.indexOf("</style>", open);
  if (open === -1 || close === -1) throw new Error("no <style> block found in app_template.html");
  const bodyStart = open + "<style>".length;
  return { text: html.slice(bodyStart, close), offset: bodyStart };
}

// Flattens every plain `selector{...}` rule out of the stylesheet, including ones nested inside @media, and
// discards @-rule preludes themselves. Each rule keeps both the comment-blanked and original text for its
// body, plus the raw span (comments included) since the previous rule, for ignore-comment detection.
function parseRules(clean, original) {
  const rules = [];
  let bufStart = 0;
  let cursor = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{") {
      const selRaw = original.slice(cursor, i);
      const sel = clean.slice(bufStart, i).trim();
      if (sel.startsWith("@")) {
        // at-rule (e.g. @media) — not a rule of its own; its contents are parsed as we continue.
        bufStart = i + 1;
        cursor = i + 1;
        continue;
      }
      let depth = 1, j = i + 1;
      while (j < clean.length && depth > 0) {
        if (clean[j] === "{") depth++;
        else if (clean[j] === "}") { depth--; if (depth === 0) break; }
        j++;
      }
      rules.push({
        selector: sel,
        bodyClean: clean.slice(i + 1, j),
        bodyOriginal: original.slice(i + 1, j),
        bodyOffset: i + 1,
        precedingRaw: selRaw,
      });
      bufStart = j + 1;
      cursor = j + 1;
      i = j;
      continue;
    }
    if (ch === "}") {
      bufStart = i + 1;
      cursor = i + 1;
    }
  }
  return rules;
}

function isIgnored(rule, ruleId) {
  const re = new RegExp(`device-parity-ignore:\\s*${ruleId}\\b`);
  return re.test(rule.precedingRaw) || re.test(rule.bodyOriginal);
}

function declarationAt(bodyOriginal, idx) {
  const start = bodyOriginal.lastIndexOf(";", idx) + 1;
  let end = bodyOriginal.indexOf(";", idx);
  if (end === -1) end = bodyOriginal.length;
  return bodyOriginal.slice(start, end + (end < bodyOriginal.length ? 1 : 0)).trim();
}

function checkR1(rules, toLine, findings) {
  const vhRe = /(?<![\w.])\d+(?:\.\d+)?vh\b/g;
  const fallbackRe = /(?<![\w.])\d+(?:\.\d+)?(dvh|svh|lvh)\b|-webkit-fill-available/;
  for (const rule of rules) {
    const matches = [...rule.bodyClean.matchAll(vhRe)];
    if (!matches.length) continue;
    if (fallbackRe.test(rule.bodyClean)) continue; // has a dvh/svh/-webkit-fill-available fallback — allowed
    const ignored = isIgnored(rule, "R1");
    for (const m of matches) {
      const line = toLine(rule.bodyOffset + m.index);
      const decl = declarationAt(rule.bodyOriginal, m.index);
      const entry = { rule: "R1", line, selector: rule.selector, text: decl };
      (ignored ? findings.ignored : findings.violations).push(entry);
    }
  }
}

function buildCustomPropertyEnvMap(rules) {
  // property name -> true if its own definition references env(safe-area-inset-top/bottom)
  const map = new Map();
  const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
  for (const rule of rules) {
    let m;
    declRe.lastIndex = 0;
    while ((m = declRe.exec(rule.bodyClean))) {
      const name = m[1], value = m[2];
      if (/env\(\s*safe-area-inset-(top|bottom)/.test(value)) map.set(name, true);
    }
  }
  return map;
}

function checkR2(rules, toLine, findings) {
  const envMap = buildCustomPropertyEnvMap(rules);
  const posRe = /position\s*:\s*(fixed|sticky)\b/;
  const edgeRe = { top: /top\s*:\s*0(?:px)?(?![.\d])/, bottom: /bottom\s*:\s*0(?:px)?(?![.\d])/ };
  const envRe = { top: /env\(\s*safe-area-inset-top/, bottom: /env\(\s*safe-area-inset-bottom/ };
  const varRe = /var\(\s*(--[\w-]+)/g;

  for (const rule of rules) {
    if (!posRe.test(rule.bodyClean)) continue;
    const referencedVars = [...rule.bodyClean.matchAll(varRe)].map((m) => m[1]);
    for (const edge of ["top", "bottom"]) {
      const m = edgeRe[edge].exec(rule.bodyClean);
      if (!m) continue;
      if (envRe[edge].test(rule.bodyClean)) continue;
      if (referencedVars.some((v) => envMap.get(v))) continue;
      const ignored = isIgnored(rule, "R2");
      const line = toLine(rule.bodyOffset + m.index);
      const decl = declarationAt(rule.bodyOriginal, m.index);
      const entry = { rule: "R2", line, selector: rule.selector, text: decl, detail: `missing env(safe-area-inset-${edge})` };
      (ignored ? findings.ignored : findings.violations).push(entry);
    }
  }
}

function checkR3(rules, toLine, findings) {
  // index every rule's selector branches (comma-separated) so an ancestor's own declarations can be found.
  const bySelector = new Map();
  for (const rule of rules) {
    for (const branch of rule.selector.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!bySelector.has(branch)) bySelector.set(branch, []);
      bySelector.get(branch).push(rule);
    }
  }
  const ancestorPropRe = /\b(transform|filter|backdrop-filter|perspective|will-change|contain)\s*:\s*(?!none\b)[^;]+/;

  for (const rule of rules) {
    if (!/position\s*:\s*sticky\b/.test(rule.bodyClean)) continue;
    const line = toLine(rule.bodyOffset);
    for (const branch of rule.selector.split(",").map((s) => s.trim()).filter(Boolean)) {
      const parts = branch.split(/\s+/).filter(Boolean);
      const ancestors = parts.slice(0, -1);
      if (!ancestors.length) {
        findings.warnings.push({
          rule: "R3", line, selector: branch,
          text: "no descendant combinator in its own selector — cannot resolve a DOM ancestor from CSS text alone",
        });
        continue;
      }
      const ignored = isIgnored(rule, "R3");
      let flagged = false;
      for (const anc of ancestors) {
        const ancRules = bySelector.get(anc) || [];
        for (const ar of ancRules) {
          if (ancestorPropRe.test(ar.bodyClean)) {
            flagged = true;
            const entry = {
              rule: "R3", line, selector: branch,
              text: `ancestor "${anc}" declares ${ancestorPropRe.exec(ar.bodyClean)[1]}, which can steal the sticky containing block`,
            };
            (ignored ? findings.ignored : findings.violations).push(entry);
          }
        }
      }
      if (!flagged && ancestors.length) {
        // resolvable ancestor(s), none of them transformed — clean, nothing to print.
      }
    }
  }
}

function run() {
  const html = readFileSync(TEMPLATE_PATH, "utf8");
  const { text: styleOriginal, offset } = extractStyleBlock(html);
  const styleClean = blankComments(styleOriginal);
  const baseLine = (html.slice(0, offset).match(/\n/g) || []).length;
  const toAbsoluteLine = (localOffset) => baseLine + (styleOriginal.slice(0, localOffset).match(/\n/g) || []).length + 1;

  const rules = parseRules(styleClean, styleOriginal);
  const findings = { violations: [], warnings: [], ignored: [] };

  checkR1(rules, toAbsoluteLine, findings);
  checkR2(rules, toAbsoluteLine, findings);
  checkR3(rules, toAbsoluteLine, findings);

  const counts = { R1: 0, R2: 0, R3: 0 };
  for (const f of findings.violations) counts[f.rule]++;

  for (const f of findings.violations) {
    console.error(`[${f.rule}] app_template.html:${f.line} — ${f.selector} { ${f.text} }${f.detail ? " — " + f.detail : ""}`);
  }
  for (const f of findings.ignored) {
    console.log(`[${f.rule}-ignored] app_template.html:${f.line} — ${f.selector} { ${f.text} }`);
  }
  for (const f of findings.warnings) {
    console.log(`[${f.rule}-warn] app_template.html:${f.line} — ${f.selector} — ${f.text}`);
  }

  console.log(`\ndevice-parity: ${findings.violations.length} violation(s) (R1=${counts.R1} R2=${counts.R2} R3=${counts.R3}), ${findings.ignored.length} ignored, ${findings.warnings.length} warning(s)`);

  if (findings.violations.length) process.exit(1);
}

run();
