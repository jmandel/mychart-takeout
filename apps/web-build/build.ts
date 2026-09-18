#!/usr/bin/env bun
/**
 * Emit the in-browser exporter + a self-contained landing page (GitHub Pages):
 *   dist/index.html       — landing / explainer with the drag-to-install button
 *   dist/privacy.html     — privacy policy (linked from the Chrome Web Store listing)
 *   dist/console.js       — paste into DevTools on a signed-in MyChart tab
 *   dist/bookmarklet.txt  — the javascript: URL, for manual bookmark creation
 *   dist/extension/       — the Chrome extension, unpacked (same bundle as takeout.js)
 *   dist/extension.zip    — …zipped for the Chrome Web Store
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync } from "../../packages/browser/src/zip";
import { buildBrowserBundle } from "./bundle";

const SIZE_BUDGET = 300 * 1024;
const REPO = "https://github.com/jmandel/mychart-takeout";

const code = await buildBrowserBundle();
const dist = join(import.meta.dir, "..", "..", "dist");
mkdirSync(dist, { recursive: true });

writeFileSync(join(dist, "console.js"), code);
const bookmarklet = "javascript:" + encodeURIComponent(code);
writeFileSync(join(dist, "bookmarklet.txt"), bookmarklet);

// href-safe: the encoded bundle has no quotes, but escape defensively.
const href = bookmarklet.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
writeFileSync(join(dist, "index.html"), landingPage(href));
writeFileSync(join(dist, "privacy.html"), privacyPage());
writeFileSync(join(dist, ".nojekyll"), "");

// The extension is its static files (apps/extension) + the bundle, verbatim.
const extSrc = join(import.meta.dir, "..", "extension");
const extOut = join(dist, "extension");
rmSync(extOut, { recursive: true, force: true });
mkdirSync(extOut, { recursive: true });
for (const f of ["manifest.json", "background.js", "icons"]) cpSync(join(extSrc, f), join(extOut, f), { recursive: true });
rmSync(join(extOut, "icons", "icon.svg")); // source art; the store wants PNGs only
writeFileSync(join(extOut, "takeout.js"), code);
const zipEntries: Record<string, Uint8Array> = {};
const walk = (dir: string): void => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else zipEntries[relative(extOut, p)] = new Uint8Array(readFileSync(p));
  }
};
walk(extOut);
const extZip = zipSync(zipEntries);
writeFileSync(join(dist, "extension.zip"), extZip);

console.log(`dist/index.html      landing page`);
console.log(`dist/extension.zip   ${(extZip.length / 1024).toFixed(1)} KB`);
console.log(`dist/console.js      ${(code.length / 1024).toFixed(1)} KB`);
console.log(`dist/bookmarklet.txt ${(bookmarklet.length / 1024).toFixed(1)} KB`);
if (code.length > SIZE_BUDGET) {
  console.error(`FAIL: console.js exceeds ${SIZE_BUDGET / 1024} KB budget`);
  process.exit(1);
}

/** The privacy policy the Chrome Web Store listing links to. Every claim here
 *  must stay true of the code: no server, no telemetry, no remote code. */
function privacyPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MyChart Takeout — privacy policy</title>
<style>
  body { margin: 0 auto; max-width: 720px; padding: 48px 20px 80px; color: #16202c; background: #f7f8fa;
    font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } a { color: #4b93ff; } }
  h1 { font-size: 32px; line-height: 1.15; } h2 { font-size: 20px; margin-top: 36px; }
</style>
</head>
<body>
<h1>MyChart Takeout — privacy policy</h1>
<p>MyChart Takeout (the bookmarklet and the browser extension) exports <em>your own</em> health record
from an Epic MyChart patient portal you are signed in to. This policy covers both.</p>

<h2>We collect nothing</h2>
<p>The tool has no server, no account, no analytics and no telemetry. Its author never receives your
health data, your portal credentials, your browsing activity, or anything else.</p>

<h2>What the tool does with your data</h2>
<p>When you start an export, the tool reads your record from your portal using the session you are
already signed in with, inside your own browser tab. It assembles a ZIP file in that tab's memory and
offers it to you as a download. The only network requests it makes go to the portal you are on. Closing
the tab discards everything that wasn't downloaded. A small run log (request paths and outcomes — no
record contents) is kept in the tab's session storage so a failed run can be diagnosed; it is cleared
when the tab closes.</p>

<h2>Browser extension permissions</h2>
<p>The extension does nothing until you click its toolbar button. <code>activeTab</code> gives it access
to the one tab you clicked it on, at that moment; <code>scripting</code> lets it start the exporter in
that tab. It requests no access to any site in advance, runs nothing in the background, and loads no
remote code — everything it runs ships inside the extension.</p>

<h2>Debug reports</h2>
<p>If something fails you can click <strong>Debug</strong> to produce a text report. It is shown to you
first and is sent nowhere; sharing it is your choice. It is designed to leave out record contents, but
it names your health system, so share it privately.</p>

<h2>Your export is yours to protect</h2>
<p>The downloaded ZIP contains sensitive health information. Once it is on your computer, keeping it safe
is up to you.</p>

<h2>Contact</h2>
<p>Questions or concerns: <a href="${REPO}/issues">${REPO}/issues</a>. The full source code is public at
<a href="${REPO}">${REPO}</a>.</p>
<p><a href="./">← MyChart Takeout</a></p>
</body>
</html>
`;
}

function landingPage(bmHref: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MyChart Takeout — export your own health data</title>
<meta name="description" content="Export all of your own health data from an Epic MyChart patient portal. Runs entirely in your browser; your data never leaves your machine.">
<style>
  :root {
    --bg: #f7f8fa; --panel: #ffffff; --ink: #16202c; --muted: #5b6672;
    --line: #e3e7ec; --accent: #1f6feb; --accent-ink: #ffffff;
    --good: #1a7f5a; --code: #eef1f5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --panel: #161b22; --ink: #e6edf3; --muted: #9aa7b4;
      --line: #263140; --accent: #4b93ff; --accent-ink: #06122a;
      --good: #3fb98a; --code: #1c2330;
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 20px 80px; }
  header { padding: 64px 0 8px; }
  .eyebrow { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  h1 { font-size: clamp(34px, 6vw, 48px); line-height: 1.08; margin: 10px 0 12px; letter-spacing: -0.02em; }
  .lede { font-size: 20px; color: var(--muted); margin: 0 0 8px; max-width: 62ch; }
  h2 { font-size: 22px; margin: 44px 0 12px; letter-spacing: -0.01em; }
  a { color: var(--accent); }
  code { background: var(--code); padding: .12em .4em; border-radius: 5px; font-size: .88em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 22px 24px; }
  .install { margin: 30px 0 6px; text-align: center; }
  .bm {
    display: inline-block; padding: 14px 26px; border-radius: 12px;
    background: var(--accent); color: var(--accent-ink); font-weight: 700; font-size: 18px;
    text-decoration: none; cursor: grab; user-select: none;
    box-shadow: 0 6px 20px rgba(31,111,235,.28); border: 0;
  }
  .bm:active { cursor: grabbing; }
  .drag-note { color: var(--muted); font-size: 14px; margin-top: 12px; }
  #click-hint { display: none; margin-top: 12px; color: var(--good); font-weight: 600; }
  #click-hint.show { display: block; }
  ol.steps { counter-reset: s; list-style: none; padding: 0; margin: 8px 0 0; }
  ol.steps li { counter-increment: s; position: relative; padding: 10px 0 10px 44px; border-top: 1px solid var(--line); }
  ol.steps li:first-child { border-top: 0; }
  ol.steps li::before {
    content: counter(s); position: absolute; left: 0; top: 12px;
    width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: var(--accent-ink);
    font-weight: 700; font-size: 14px; display: grid; place-items: center;
  }
  ul.grid { list-style: none; padding: 0; margin: 8px 0 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px 22px; }
  ul.grid li { padding-left: 20px; position: relative; color: var(--ink); }
  ul.grid li::before { content: "›"; position: absolute; left: 4px; color: var(--accent); font-weight: 700; }
  @media (max-width: 560px) { ul.grid { grid-template-columns: 1fr; } }
  .trust li { margin: 6px 0; }
  .trust strong { color: var(--ink); }
  .caution { margin-top: 18px; border-left: 4px solid var(--accent); }
  .caution h3 { margin: 0 0 8px; font-size: 17px; }
  .caution p { margin: 0; font-size: 16px; }
  footer { margin-top: 56px; padding-top: 22px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
  .pill { display: inline-block; font-size: 12px; font-weight: 700; color: var(--good);
    border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">Your records, in your hands</div>
    <h1>MyChart&nbsp;Takeout</h1>
    <p class="lede">Export <strong>all of your own health data</strong> from an Epic
      <strong>MyChart</strong> patient portal — problems, medications, results, visit notes,
      messages, and more — into a single ZIP.</p>
    <p><span class="pill">Runs in your browser · data never leaves your machine · open source</span></p>
  </header>

  <div class="panel install">
    <p style="margin:0 0 16px; font-weight:600;">Drag this button to your bookmarks bar:</p>
    <a class="bm" href="${bmHref}"
       onclick="event.preventDefault();document.getElementById('click-hint').classList.add('show');return false;"
       draggable="true">⬇ MyChart Takeout</a>
    <div class="drag-note">Show the bookmarks bar first with <code>Ctrl/Cmd&nbsp;+&nbsp;Shift&nbsp;+&nbsp;B</code>.</div>
    <div id="click-hint">👆 Don't click it here — <em>drag</em> it to your bookmarks bar, then use it on a MyChart page.</div>
  </div>

  <h2>How to use it</h2>
  <ol class="steps">
    <li>Drag the <strong>MyChart Takeout</strong> button above onto your browser's bookmarks bar.</li>
    <li>Open your health system's <strong>MyChart</strong> site and <strong>sign in</strong> as you normally would.</li>
    <li>Click the <strong>MyChart Takeout</strong> bookmark. A small panel appears; click <strong>Start export</strong>.</li>
    <li>Leave the tab open until a <strong>Download</strong> button appears, then save the ZIP.</li>
  </ol>
  <p style="color:var(--muted);font-size:15px;margin-top:14px;">Exporting a child or dependent you have
    proxy access to? Switch to their record in MyChart first, then run the bookmarklet — each ZIP is named
    for its patient.</p>

  <h2>What you get</h2>
  <ul class="grid">
    <li>Problems &amp; diagnoses</li><li>Allergies</li>
    <li>Medications</li><li>Immunizations</li>
    <li>Lab &amp; imaging results</li><li>Radiology / pathology narratives</li>
    <li>Visits + After-Visit Summaries</li><li>Clinical notes</li>
    <li>Secure messages</li><li>Care team</li>
    <li>Medical / family / social history</li><li>Insurance &amp; coverage</li>
    <li>Referrals</li><li>Growth charts (pediatric)</li>
    <li>Implanted devices (UDI, model, serial)</li><li>Care to-dos &amp; reminders</li>
    <li>Access log — who viewed your record</li><li>Connected apps &amp; linked organizations</li>
    <li>Notification &amp; security settings</li><li>Patient-tracked vitals</li>
    <li>Standards C-CDA package</li><li>A readable <code>PATIENT_SUMMARY.md</code> + CSV indexes</li>
  </ul>

  <h2>How it protects your data</h2>
  <ul class="trust">
    <li><strong>Stays on your computer.</strong> The export runs entirely inside your browser tab and
      writes a ZIP straight to your downloads. Nothing is uploaded anywhere.</li>
    <li><strong>No password handling.</strong> It uses the session you're <em>already</em> signed into —
      it never sees, stores, or transmits your credentials.</li>
    <li><strong>No server, no account.</strong> This page is static; the bookmarklet is self-contained.
      There is no backend to send data to.</li>
    <li><strong>Open source.</strong> Read every line before you run it — <a href="${REPO}">source on GitHub</a>.</li>
  </ul>

  <div class="panel caution">
    <h3>A note of caution</h3>
    <p>A bookmarklet is code that runs inside your logged-in session, with all the access you have
      there. That is what makes this tool possible. It is also what makes tools like it dangerous when
      they come from someone you don't trust: a malicious script installed the same way could send your
      records to a stranger, capture your credentials, or act in your account. MyChart Takeout's code is
      public so anyone can check what it does — but that only helps if someone actually reads it. If you
      can't review the code yourself, make sure you really trust whoever is providing it. Asking an AI to
      review can help, too (though a determined attacker can hide behavior that a quick review will miss).
      This is not hypothetical: health systems are seeing a rise in attackers trying to trick patients
      into running scripts in their portals.</p>
  </div>

  <h2>Prefer not to use a bookmarklet?</h2>
  <p><strong>Console:</strong> on a signed-in MyChart tab, open your browser's DevTools → Console, type
    <code>allow pasting</code> if prompted, paste the contents of
    <a href="console.js">console.js</a>, press Enter, then click <strong>Start export</strong>.</p>
  <p><strong>Manual bookmark:</strong> some browsers strip <code>javascript:</code> when you paste a URL.
    If so, create the bookmark, then edit its URL and type <code>javascript:</code> back at the front —
    full string in <a href="bookmarklet.txt">bookmarklet.txt</a>.</p>
  <p><strong>Power users / automation:</strong> a CDP-driven CLI (attach to an already-open browser,
    capture raw responses, export every proxy subject at once) lives in the
    <a href="${REPO}">repository</a>.</p>

  <footer>
    MyChart Takeout is an independent open-source tool and is not affiliated with or endorsed by
    Epic Systems. “MyChart” and “Epic” are trademarks of Epic Systems Corporation.
    &nbsp;·&nbsp; <a href="privacy.html">Privacy</a> &nbsp;·&nbsp; <a href="${REPO}">GitHub</a>
  </footer>
</div>
</body>
</html>
`;
}
