/**
 * Minimal raw CDP client over Bun's native WebSocket.
 *
 * Why not a browser-automation library: its CDP-attach path performs the
 * websocket upgrade through a bundled client that never completes under Bun's
 * node-compat layer (hangs at "<ws connecting>"). Bun's native WebSocket
 * drives the same endpoint fine, and this harness needs only a tiny slice of
 * the protocol (Target/Runtime/Page/Network).
 */

type Json = Record<string, unknown>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
}

export type EventHandler = (params: never) => void;

/** Event source + command surface — what NetLogger and CdpPage need. */
export interface CdpEvents {
  send<T = Json>(method: string, params?: Json, sessionId?: string): Promise<T>;
  on(method: string, handler: (params: never) => void, sessionId?: string): void;
}

export class CdpConnection implements CdpEvents {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<(params: never) => void>>();
  private closed = false;

  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => this.failAll("CDP connection closed");
    ws.onerror = () => this.failAll("CDP websocket error");
  }

  /** httpEndpoint e.g. "http://127.0.0.1:9222" → GET /json/version → ws. */
  static async connect(httpEndpoint: string, timeoutMs = 15000): Promise<CdpConnection> {
    const res = await fetch(new URL("/json/version", httpEndpoint));
    if (!res.ok) throw new Error(`CDP endpoint ${httpEndpoint}: HTTP ${res.status}`);
    const v = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (!v.webSocketDebuggerUrl) throw new Error("CDP /json/version has no webSocketDebuggerUrl");
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`CDP websocket open timeout (${timeoutMs}ms)`)), timeoutMs);
      ws.onopen = () => {
        clearTimeout(to);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(to);
        reject(new Error("CDP websocket failed to open"));
      };
    });
    return new CdpConnection(ws);
  }

  private onMessage(data: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string; data?: string };
      method?: string;
      params?: unknown;
      sessionId?: string;
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const extra = msg.error.data ? ` (${msg.error.data})` : "";
        p.reject(new Error(`${p.method}: ${msg.error.message ?? "CDP error"}${extra}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const set = this.handlers.get(`${msg.sessionId ?? ""}|${msg.method}`);
      if (set) for (const h of set) h(msg.params as never);
    }
  }

  private failAll(why: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(`${why} (awaiting ${p.method})`));
    this.pending.clear();
  }

  send<T = Json>(method: string, params: Json = {}, sessionId?: string, timeoutMs = 60000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`CDP connection closed (sending ${method})`));
    const id = this.nextId++;
    const msg: Json = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      // A command reply can vanish (page dialog blocking the renderer, target
      // swap, dropped session) — without a client-side deadline the whole
      // export would hang, so every send self-expires.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: CDP reply timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      const settle = (fn: (v: never) => void) => (v: never) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, {
        resolve: settle(resolve as (v: never) => void) as (v: unknown) => void,
        reject: settle(reject as (e: never) => void) as (e: Error) => void,
        method,
      });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Subscribe to an event, optionally scoped to a flat-session id. */
  on(method: string, handler: (params: never) => void, sessionId?: string): void {
    const key = `${sessionId ?? ""}|${method}`;
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(handler);
  }

  /** Attach to a page target in flat mode; returns the sessionId. */
  async attachPage(targetId: string): Promise<string> {
    const r = await this.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return r.sessionId;
  }

  /** Close the websocket only — never Browser.close (would kill the browser). */
  close(): void {
    this.failAll("CDP connection closed");
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
