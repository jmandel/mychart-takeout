import type { DomAccess } from "@mychart/core";
import { CdpClient } from "./client";
import { makeDomAccess } from "./dom";
import { NetLogger } from "./netlog";
import { CdpPage } from "./page";
import { CdpConnection } from "./rawcdp";

/** Derive origin + app path prefix from the live page URL (no hardcoded host). */
export function deriveOriginPrefix(pageUrl: string): { origin: string; prefix: string } {
  try {
    const u = new URL(pageUrl);
    const seg = u.pathname.split("/").filter(Boolean)[0];
    return { origin: u.origin, prefix: seg ? "/" + seg : "/MyChart" };
  } catch {
    return { origin: "", prefix: "/MyChart" };
  }
}

export interface TargetInfoLike {
  targetId: string;
  type: string;
  url: string;
}

/** Pick the tab whose URL contains matchUrl (case-insensitive), else first. */
export function pickTarget<T extends { url: string }>(targets: T[], matchUrl: string): T {
  const m = matchUrl.toLowerCase();
  for (const t of targets) {
    if ((t.url || "").toLowerCase().includes(m)) return t;
  }
  const first = targets[0];
  if (!first) throw new Error("no open pages in the CDP browser");
  return first;
}

export interface ConnectOpts {
  /** substring match to pick the MyChart tab (case-insensitive). */
  matchUrl?: string;
  /** output dir for the passive network log (enables capture when set). */
  out?: string;
  captureBodies?: boolean;
  /** CDP http endpoint; defaults to $CDP_URL or http://127.0.0.1:9222. */
  endpoint?: string;
}

/**
 * Attaches to an already-running, authenticated Chromium over raw CDP
 * (Bun-native WebSocket). Port of harness/mychart.py Session.
 */
export class CdpSession {
  private constructor(
    readonly conn: CdpConnection,
    public page: CdpPage,
    readonly origin: string,
    readonly prefix: string,
    readonly netlog: NetLogger | undefined,
    private readonly matchUrl: string,
    private targets: TargetInfoLike[],
  ) {}

  /** Snapshot of open page tabs at connect/refresh time (targets verb). */
  get context(): { pages(): { url(): string }[] } {
    const ts = this.targets;
    return { pages: () => ts.map((t) => ({ url: () => t.url })) };
  }

  static async connect(opts: ConnectOpts = {}): Promise<CdpSession> {
    const matchUrl = opts.matchUrl ?? "MyChart";
    const endpoint = opts.endpoint ?? process.env.CDP_URL ?? "http://127.0.0.1:9222";
    const conn = await CdpConnection.connect(endpoint);

    const targets = await CdpSession.pageTargets(conn);
    const info = pickTarget(targets, matchUrl);
    const sessionId = await conn.attachPage(info.targetId);

    const netlog = opts.out
      ? new NetLogger(opts.out, { captureBodies: opts.captureBodies })
      : undefined;
    netlog?.attachCdp(conn, sessionId);

    const page = await CdpPage.create(conn, sessionId, info.url);
    const { origin, prefix } = deriveOriginPrefix(page.url());
    return new CdpSession(conn, page, origin, prefix, netlog, matchUrl, targets);
  }

  private static async pageTargets(conn: CdpConnection): Promise<TargetInfoLike[]> {
    const r = await conn.send<{ targetInfos: TargetInfoLike[] }>("Target.getTargets");
    return r.targetInfos.filter((t) => t.type === "page");
  }

  /** Re-select + re-attach the MyChart tab (it may have navigated/closed). */
  async refreshPage(): Promise<CdpPage> {
    this.targets = await CdpSession.pageTargets(this.conn);
    const info = pickTarget(this.targets, this.matchUrl);
    const sessionId = await this.conn.attachPage(info.targetId);
    this.netlog?.attachCdp(this.conn, sessionId);
    this.page = await CdpPage.create(this.conn, sessionId, info.url);
    return this.page;
  }

  client(): CdpClient {
    return new CdpClient(this.page, this.origin, this.prefix);
  }

  domAccess(): DomAccess {
    return makeDomAccess(this.page, this.origin, this.prefix);
  }

  /** Disconnects the CDP websocket; does NOT kill the user's browser. */
  async close(): Promise<void> {
    this.netlog?.flush();
    this.conn.close();
  }
}
