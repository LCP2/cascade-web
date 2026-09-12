// CAS-960: WCAG 2.2 AA contrast check over the CSS custom-property token pairs app_template.html
// actually uses for text. Grep-level (per the ticket, same spirit as xss-sinks.mjs): for every
// `color:var(--token)` declaration in the file's <style> block, measure that token's resolved hex
// (from the :root definitions) against every real surface background (--bg, --panel, --panel2, --band —
// every background a panel of text actually sits on). Body text needs >=4.5:1 on every surface it can
// appear on.
//
// Two kinds of site are not "body text at 4.5:1" even though they use color:var(--x) on a text node.
// Mark both deliberately with an inline comment naming the rule, same convention as xss-sinks.mjs — still
// measured and printed, just not gated on 4.5:1 (LARGE-TEXT is gated on 3:1 instead):
//   /* a11y-contrast-ignore: ICON — reason */        — colours an <svg>/glyph, not a text run (WCAG 1.4.11, 3:1)
//   /* a11y-contrast-ignore: LARGE-TEXT — reason */  — >=18.66px bold or >=24px regular (WCAG large text, 3:1)
//
// Run with `node tests/lint/a11y-contrast.mjs`. Writes qa-a11y-report.txt. Exits non-zero on any
// non-ignored text-colour site under 4.5:1 against any of the 4 surfaces.

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const TEMPLATE_PATH = path.join(REPO_ROOT, "app_template.html");
const REPORT_PATH = path.join(REPO_ROOT, "qa-a11y-report.txt");

const SURFACES = ["--bg", "--panel", "--panel2", "--band"];
const ICON_IGNORE_RE = /a11y-contrast-ignore:\s*ICON\b/;
const LARGE_TEXT_IGNORE_RE = /a11y-contrast-ignore:\s*LARGE-TEXT\b/;
const LARGE_TEXT_MIN_RATIO = 3;

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relLuminance([r, g, b]) {
  const f = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [R, G, B] = [f(r), f(g), f(b)];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(hexA, hexB) {
  const La = relLuminance(hexToRgb(hexA));
  const Lb = relLuminance(hexToRgb(hexB));
  const [lighter, darker] = La >= Lb ? [La, Lb] : [Lb, La];
  return (lighter + 0.05) / (darker + 0.05);
}

function run() {
  const html = readFileSync(TEMPLATE_PATH, "utf8");
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  const css = styleMatch ? styleMatch[1] : html;
  const cssStartLine = styleMatch ? html.slice(0, styleMatch.index).split("\n").length : 0;

  const tokens = {};
  const defRe = /(--[a-zA-Z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*[;}]/g;
  let d;
  while ((d = defRe.exec(css))) tokens[d[1]] = d[2];

  const cssLines = css.split("\n");
  const sites = [];
  const useRe = /(?:^|[;{ ])color:\s*var\((--[a-zA-Z0-9-]+)\)/;
  for (let i = 0; i < cssLines.length; i++) {
    const m = cssLines[i].match(useRe);
    if (!m || !tokens[m[1]]) continue;
    const line = cssLines[i];
    sites.push({
      token: m[1], line: cssStartLine + i + 1,
      iconIgnored: ICON_IGNORE_RE.test(line),
      largeText: LARGE_TEXT_IGNORE_RE.test(line),
    });
  }

  const lines = [];
  const failures = [];
  lines.push("CAS-960 contrast report — every color:var(--token) text-colour site, against every real surface background.");
  lines.push("WCAG AA body text needs >= 4.5:1; ICON sites need 3:1 (1.4.11); LARGE-TEXT sites need 3:1 (large-text AA).\n");

  for (const site of sites) {
    const minRatio = (site.iconIgnored || site.largeText) ? LARGE_TEXT_MIN_RATIO : 4.5;
    for (const bg of SURFACES) {
      if (!tokens[bg]) continue;
      const ratio = contrastRatio(tokens[site.token], tokens[bg]);
      const pass = ratio >= minRatio;
      const tag = site.iconIgnored ? " [ICON, 3:1 rule]" : site.largeText ? " [LARGE-TEXT, 3:1 rule]" : "";
      lines.push(`app_template.html:${site.line} ${site.token} (${tokens[site.token]}) on ${bg} (${tokens[bg]}): ${ratio.toFixed(2)}:1 — ${pass ? "PASS" : "FAIL"}${tag}`);
      if (!pass) failures.push({ ...site, bg, ratio });
    }
  }

  lines.push(`\ncontrast: ${sites.length} site(s) x ${SURFACES.length} surface(s), ${failures.length} failure(s) under 4.5:1`);

  appendFileSync(REPORT_PATH, lines.join("\n") + "\n\n");
  console.log(lines.join("\n"));

  if (failures.length) process.exit(1);
}

run();
