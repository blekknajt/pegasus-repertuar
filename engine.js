// Ocena pozycji: najpierw chmura Lichess (Stockfish, duża głębokość, tylko popularne pozycje),
// a gdy pozycji tam nie ma albo brak sieci — lokalny Stockfish 17.1 lite (WASM, GPLv3) w Web Workerze.

const SF_URL = "lib/stockfish/stockfish-17.1-lite-single-03e3232.js";
const LOCAL_DEPTH = 18;

/** Wynik: {source, depth, lines: [{cp|mate, pv: [uci…]}]}; cp/mate z perspektywy białych. */
export class Engine {
  constructor() {
    this.worker = null;
    this.ready = null;
    this.job = 0;
    this.cache = new Map();
  }

  /** Ocena `fen`; onUpdate wołane wielokrotnie (lokalny silnik pogłębia wynik). */
  async analyse(fen, onUpdate, { multiPv = 3 } = {}) {
    const job = ++this.job;
    this.stopLocal();
    const key = fen.split(" ").slice(0, 4).join(" ");
    if (this.cache.has(key)) return onUpdate(this.cache.get(key));

    const cloud = await this.cloud(fen, multiPv).catch(() => null);
    if (job !== this.job) return;
    if (cloud) {
      this.cache.set(key, cloud);
      return onUpdate(cloud);
    }
    onUpdate({ source: "Stockfish w tablecie", depth: 0, lines: [], pending: true });
    await this.local(fen, multiPv, job, (res) => {
      if (job !== this.job) return;
      if (res.done) this.cache.set(key, res);
      onUpdate(res);
    });
  }

  async cloud(fen, multiPv) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(`https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`, { signal: ctl.signal });
      if (!r.ok) return null; // 404 = pozycji nie ma w chmurze
      const d = await r.json();
      return {
        source: "chmura Lichess",
        depth: d.depth,
        done: true,
        lines: d.pvs.map((p) => ({ cp: p.cp, mate: p.mate, pv: p.moves.split(" ") })),
      };
    } finally {
      clearTimeout(t);
    }
  }

  _boot() {
    if (this.ready) return this.ready;
    this.worker = new Worker(SF_URL);
    this.ready = new Promise((resolve, reject) => {
      const h = (e) => {
        if (String(e.data).startsWith("uciok")) {
          this.worker.removeEventListener("message", h);
          resolve();
        }
      };
      this.worker.addEventListener("message", h);
      this.worker.addEventListener("error", (e) => reject(e));
      this.worker.postMessage("uci");
    });
    return this.ready;
  }

  stopLocal() {
    if (this.worker && this._running) this.worker.postMessage("stop");
  }

  async local(fen, multiPv, job, onUpdate) {
    await this._boot();
    if (job !== this.job) return;
    // poczekaj, aż poprzednie liczenie się zakończy
    while (this._running) await new Promise((r) => setTimeout(r, 30));
    if (job !== this.job) return;
    const white = fen.split(" ")[1] === "w";
    const lines = [];
    let depth = 0;
    this._running = true;
    await new Promise((resolve) => {
      const h = (e) => {
        const s = String(e.data);
        if (s.startsWith("info") && s.includes(" pv ")) {
          const g = (re) => (s.match(re) || [])[1];
          const d = Number(g(/ depth (\d+)/));
          const k = Number(g(/ multipv (\d+)/) || 1) - 1;
          const cp = g(/ score cp (-?\d+)/), mate = g(/ score mate (-?\d+)/);
          const sign = white ? 1 : -1; // silnik podaje z perspektywy strony na posunięciu
          lines[k] = {
            cp: cp !== undefined ? sign * Number(cp) : undefined,
            mate: mate !== undefined ? sign * Number(mate) : undefined,
            pv: s.split(" pv ")[1].trim().split(" "),
          };
          if (k === 0 && d > depth) {
            depth = d;
            if (d >= 8) onUpdate({ source: "Stockfish w tablecie", depth, lines: lines.filter(Boolean).map((l) => ({ ...l })) });
          }
        } else if (s.startsWith("bestmove")) {
          this.worker.removeEventListener("message", h);
          this._running = false;
          onUpdate({ source: "Stockfish w tablecie", depth, done: true, lines: lines.filter(Boolean) });
          resolve();
        }
      };
      this.worker.addEventListener("message", h);
      this.worker.postMessage(`setoption name MultiPV value ${multiPv}`);
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go depth ${LOCAL_DEPTH}`);
    });
  }
}

/** „+0.3”, „−1.2”, „M3” — z perspektywy białych. */
export function scoreText(l) {
  if (l.mate !== undefined && l.mate !== null) return (l.mate > 0 ? "+M" : "−M") + Math.abs(l.mate);
  if (l.cp === undefined || l.cp === null) return "?";
  const v = l.cp / 100;
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1);
}
