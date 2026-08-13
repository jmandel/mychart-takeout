#!/usr/bin/env bun
/**
 * MyChart export CLI (Bun) — port of harness/mychart.py CLI verbs + export.py
 * main() orchestration. Drives an already-authenticated Chromium over CDP.
 *
 * Verbs:
 *   targets | whereami
 *   goto <url> [--snap NAME] [--settle MS]
 *   eval <js> | eval --file F
 *   api <url> [--post JSON] [--method M] [--out FILE]
 *   snapshot <name>
 *   export [--out DIR] [--screenshots] [--no-dom] [--no-raw] [--ccda] [--only PHASE]...
 *   report --dir DIR
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildReport,
  ExportStore,
  makeCtx,
  Mc,
  phases,
  renderGapsMd,
  summarizeGaps,
  type Phase,
  type PhaseCtx,
} from "@mychart/core";
import {
  CdpSession,
  discoverSubjects,
  FsSink,
  loadExportDirIntoStore,
  salvage,
  snapshot,
  switchToSelf,
  switchToSubject,
  type Subject,
} from "@mychart/cdp";

// ------------------------------------------------------------------ arg parse
interface Args {
  _: string[];
  flags: Record<string, boolean>;
  opts: Record<string, string>;
  multi: Record<string, string[]>;
}
const BOOL = new Set(["screenshots", "no-dom", "no-raw", "ccda", "proxies"]);
const MULTI = new Set(["only"]);

function parse(argv: string[]): Args {
  const a: Args = { _: [], flags: {}, opts: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      if (BOOL.has(key)) a.flags[key] = true;
      else if (MULTI.has(key)) (a.multi[key] ??= []).push(argv[++i]!);
      else a.opts[key] = argv[++i]!;
    } else a._.push(t);
  }
  return a;
}

const today = (): string => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ export
const PHASE_ALIAS: Record<string, string> = {
  "test-results": "testResults",
  testresults: "testResults",
  "access-log": "accessLog",
  accesslog: "accessLog",
};
const norm = (p: string): string => PHASE_ALIAS[p] ?? p;

interface ExportOpts {
  active: Set<string>;
  noDom: boolean;
  screenshots: boolean;
  doSalvage: boolean;
  host: string;
}

/** Export the CURRENTLY-ACTIVE patient context into `outDir`. */
async function exportSubject(session: CdpSession, outDir: string, o: ExportOpts): Promise<void> {
  const ctx: PhaseCtx = makeCtx({
    client: session.client(),
    sink: new FsSink(outDir),
    dom: session.domAccess(outDir),
    screenshots: o.screenshots,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const run = async (name: string, phase: Phase): Promise<void> => {
    if (!o.active.has(name)) return;
    try {
      await phase(ctx);
    } catch (e) {
      console.log(`  !! phase ${name} failed: ${e}`);
    }
  };
  await run("structured", phases.structured);
  await run("testResults", phases.testResults);
  await run("visits", phases.visits);
  await run("messages", phases.messages);
  await run("flowsheets", phases.flowsheets);
  await run("accessLog", phases.accessLog);
  await run("documents", phases.documents);
  await run("ccda", phases.ccda);
  if (!o.noDom) await run("dom", phases.dom);
  if (o.doSalvage && o.active.has("salvage")) salvage(outDir, session.origin);

  await ctx.store.saveJson("_manifest.json", ctx.manifest);
  const gaps = summarizeGaps(ctx.manifest);
  await ctx.store.saveJson("gaps.json", gaps);
  await ctx.store.saveText("GAPS.md", renderGapsMd(gaps));
  console.log(
    `  gaps: ${gaps.ok}/${gaps.attempted} ok, ${gaps.empty} empty, ${gaps.concerns.length} need attention`,
  );
  if (o.active.has("report")) {
    try {
      await buildReport(ctx.store, { today: today(), source: `Epic MyChart (${o.host})` });
    } catch (e) {
      console.log(`  !! phase report failed: ${e}`);
    }
  }
}

async function runExport(a: Args): Promise<void> {
  const out = a.opts.out ?? "export";
  const ccda = !!a.flags.ccda;
  const proxies = !!a.flags.proxies;
  const defaults = [
    "structured", "testResults", "visits", "messages", "flowsheets", "accessLog", "documents",
    ...(ccda ? ["ccda"] : []), "dom", "salvage", "report",
  ];
  const only = (a.multi.only ?? []).map(norm);
  const opts: ExportOpts = {
    active: new Set(only.length ? only : defaults),
    noDom: !!a.flags["no-dom"],
    screenshots: !!a.flags.screenshots,
    doSalvage: true,
    host: "",
  };

  const session = await CdpSession.connect({ out, captureBodies: !a.flags["no-raw"], matchUrl: a.opts.host });
  try {
    opts.host = (() => {
      try { return new URL(session.origin).host; } catch { return session.origin; }
    })();

    // session sanity check (origin is derived; require a real http page + token)
    const mc = new Mc(session.client());
    const tok = await mc.token();
    const url = session.page.url() || "";
    if (!tok || !/^https?:/i.test(url) || url.includes("Login")) {
      console.log("!! Not authenticated (no CSRF token or on login page). Sign in, then re-run.");
      process.exit(2);
    }

    if (!proxies) {
      console.log(`Exporting to ./${out}  (session OK, token ${tok.slice(0, 10)}…)`);
      await exportSubject(session, out, opts);
      console.log(`\n✔ export complete → ${out}`);
      return;
    }

    // ---- proxy-aware: export every accessible subject into out/<name>/ ----
    const subjects = await discoverSubjects(session);
    const self = subjects.find((s) => s.isSelf) ?? { name: "self", eid: "", isSelf: true };
    console.log(`proxy mode: ${subjects.length} subject(s): ${subjects.map((s) => s.name).join(", ")}`);
    opts.doSalvage = false; // raw_network is session-wide; skip per-subject salvage
    const slug = (n: string) => n.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "patient";
    for (const s of subjects) {
      const ok = await switchToSubject(session, mc, s);
      if (!ok) {
        console.log(`!! could not switch to ${s.name}; skipping`);
        if (!s.isSelf) await switchToSelf(session, mc, self.name);
        continue;
      }
      const subOut = `${out}/${slug(s.name)}`;
      console.log(`\n== ${s.name}${s.isSelf ? " (you)" : " (proxy)"} → ${subOut} ==`);
      await exportSubject(session, subOut, opts);
      if (!s.isSelf) {
        const restored = await switchToSelf(session, mc, self.name);
        if (!restored) {
          console.log(`!! FAILED to restore to ${self.name} after ${s.name} — aborting remaining subjects`);
          break;
        }
      }
    }
    await switchToSelf(session, mc, self.name); // belt-and-suspenders
    console.log(`\n✔ proxy export complete → ${out} (restored to ${self.name})`);
  } finally {
    await session.close();
  }
}

// ------------------------------------------------------------------ report-only
async function runReport(a: Args): Promise<void> {
  const dir = a.opts.dir;
  if (!dir) {
    console.error("report: --dir DIR required");
    process.exit(1);
  }
  const store = new ExportStore(new FsSink(dir));
  const n = loadExportDirIntoStore(store, dir);
  console.log(`loaded ${n} json files from ${dir}`);
  await buildReport(store, { today: today() });
}

// ------------------------------------------------------------------ probe verbs
async function runProbe(cmd: string, a: Args): Promise<void> {
  const session = await CdpSession.connect({ matchUrl: a.opts.host });
  try {
    const page = session.page;
    if (cmd === "targets") {
      for (const p of session.context.pages()) console.log(p.url());
      return;
    }
    if (cmd === "whereami") {
      console.log(JSON.stringify({ url: page.url(), title: await page.title() }, null, 2));
      return;
    }
    if (cmd === "goto") {
      const url = a._[1];
      if (!url) throw new Error("goto <url> required");
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      } catch (e) {
        console.error(`[goto warn] ${e}`);
      }
      try {
        await page.waitForLoadState("networkidle", { timeout: 45000 });
      } catch {
        /* ignore */
      }
      await page.waitForTimeout(a.opts.settle ? Number(a.opts.settle) : 2500);
      console.log("now at:", page.url());
      if (a.opts.snap) console.log(JSON.stringify(await snapshot(page, "export", a.opts.snap), null, 2));
      return;
    }
    if (cmd === "eval") {
      const js = a.opts.file ? readFileSync(a.opts.file, "utf-8") : a._[1];
      if (!js) throw new Error("eval <js> or --file F required");
      const res = await page.evaluate(js as string);
      console.log(typeof res === "string" ? res : JSON.stringify(res, null, 2));
      return;
    }
    if (cmd === "snapshot") {
      const name = a._[1];
      if (!name) throw new Error("snapshot <name> required");
      console.log(JSON.stringify(await snapshot(page, a.opts.out ?? "export", name), null, 2));
      return;
    }
    if (cmd === "api") {
      const url = a._[1];
      if (!url) throw new Error("api <url> required");
      const post = a.opts.post;
      const method = a.opts.method ?? (post != null ? "POST" : "GET");
      const client = session.client();
      const res = await client.fetchText(url, {
        method,
        ...(post != null ? { body: post, headers: { "Content-Type": "application/json" } } : {}),
      });
      if (a.opts.out) {
        writeFileSync(a.opts.out, res.body);
        const { body, ...meta } = res;
        void body;
        console.log(JSON.stringify(meta, null, 2));
        console.log("wrote", a.opts.out, "bytes", res.body.length);
      } else {
        console.log(JSON.stringify(res, null, 2).slice(0, 6000));
      }
      return;
    }
    throw new Error(`unknown command: ${cmd}`);
  } finally {
    await session.close();
  }
}

// ------------------------------------------------------------------ main
async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd) {
    console.error(
      "usage: mychart <targets|whereami|goto|eval|api|snapshot|export|report> [...]",
    );
    process.exit(1);
  }
  if (cmd === "export") return runExport(a);
  if (cmd === "report") return runReport(a);
  return runProbe(cmd, a);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
