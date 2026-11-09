// Repertuar: drzewo pozycji, import PGN (z wariantami), powtórki (SRS), dobór linii.
import { Chess } from "./lib/chess.js";

export const DAY = 86400000;
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Klucz pozycji: bez licznika posunięć (transpozycje łączą się). */
export const posKey = (fen) => fen.split(" ").slice(0, 4).join(" ");
export const turnOf = (fen) => fen.split(" ")[1];

// ---------------------------------------------------------------- przechowywanie (IndexedDB)

const DB_NAME = "pegasus-repertuar";
let dbp = null;

function idb() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

export async function kvGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction("kv").objectStore("kv").get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function kvSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/**
 * Stan aplikacji:
 *  reps: [{id, name, color: 'w'|'b', roots: [posKey], nodes: {posKey: {fen, moves: {uci: Edge}}}}]
 *  Edge: {san, to: posKey, comment?, srs?: {due, ivl, ease, reps, lapses, line}}
 *  log: [{t, rep, ok, learn?}]
 */
export const store = {
  data: { reps: [], log: [], settings: {} },
  _saveTimer: null,

  async load() {
    const d = await kvGet("data");
    if (d) this.data = { reps: [], log: [], settings: {}, ...d };
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  },

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => kvSet("data", this.data), 300);
  },

  saveNow() {
    clearTimeout(this._saveTimer);
    return kvSet("data", this.data);
  },

  rep(id) {
    return this.data.reps.find((r) => r.id === id);
  },

  newRep(name, color) {
    const rep = { id: "r" + Date.now().toString(36), name, color, roots: [], nodes: {}, created: Date.now() };
    this.data.reps.push(rep);
    this.save();
    return rep;
  },

  deleteRep(id) {
    this.data.reps = this.data.reps.filter((r) => r.id !== id);
    this.save();
  },

  logReview(rep, ok, learn = false) {
    this.data.log.push({ t: Date.now(), rep: rep.id, ok, learn });
    if (this.data.log.length > 20000) this.data.log.splice(0, this.data.log.length - 20000);
    this.save();
  },
};

/** Sprawdza strukturę kopii przed zastąpieniem danych na urządzeniu. */
export function validateBackup(data) {
  if (!data || !Array.isArray(data.reps) || !Array.isArray(data.log) ||
      !data.settings || typeof data.settings !== "object" || Array.isArray(data.settings)) {
    throw new Error("To nie jest poprawna kopia zapasowa tej aplikacji.");
  }
  for (const rep of data.reps) {
    if (!rep || typeof rep.id !== "string" || typeof rep.name !== "string" ||
        !["w", "b"].includes(rep.color) || !Array.isArray(rep.roots) ||
        !rep.nodes || typeof rep.nodes !== "object" || Array.isArray(rep.nodes)) {
      throw new Error("Kopia zawiera uszkodzony repertuar.");
    }
    for (const key of rep.roots) {
      if (!Object.hasOwn(rep.nodes, key)) throw new Error("Kopia zawiera brakującą pozycję startową.");
    }
    for (const node of Object.values(rep.nodes)) {
      if (!node || typeof node.fen !== "string" || !node.moves ||
          typeof node.moves !== "object" || Array.isArray(node.moves)) {
        throw new Error("Kopia zawiera uszkodzoną pozycję.");
      }
      for (const edge of Object.values(node.moves)) {
        if (!edge || typeof edge.san !== "string" || typeof edge.to !== "string" ||
            !Object.hasOwn(rep.nodes, edge.to)) {
          throw new Error("Kopia zawiera ruch bez dalszej pozycji.");
        }
      }
    }
  }
  return data;
}

// ---------------------------------------------------------------- import PGN

const RESULT_RE = /^(1-0|0-1|1\/2-1\/2|\*)$/;

function tokenize(text) {
  const toks = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "[") {
      const end = text.indexOf("]", i);
      const body = text.slice(i + 1, end < 0 ? n : end);
      const m = body.match(/^\s*(\w+)\s+"((?:[^"\\]|\\.)*)"/);
      if (m) toks.push({ t: "tag", name: m[1], value: m[2].replace(/\\(.)/g, "$1") });
      i = end < 0 ? n : end + 1;
    } else if (c === "{") {
      const end = text.indexOf("}", i);
      toks.push({ t: "comment", v: text.slice(i + 1, end < 0 ? n : end) });
      i = end < 0 ? n : end + 1;
    } else if (c === ";") {
      const end = text.indexOf("\n", i);
      toks.push({ t: "comment", v: text.slice(i + 1, end < 0 ? n : end) });
      i = end < 0 ? n : end + 1;
    } else if (c === "(") {
      toks.push({ t: "(" });
      i++;
    } else if (c === ")") {
      toks.push({ t: ")" });
      i++;
    } else if (c === "%" && (i === 0 || text[i - 1] === "\n")) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
    } else {
      let j = i;
      while (j < n && !/[\s{}();[\]]/.test(text[j])) j++;
      let w = text.slice(i, j);
      i = j;
      if (RESULT_RE.test(w)) {
        toks.push({ t: "result" });
        continue;
      }
      if (w[0] === "$") continue; // NAG
      w = w.replace(/^\d+\.+/, ""); // numer posunięcia sklejony z ruchem („1.e4”)
      if (!w || /^\d+\.*$/.test(w) || /^\.+$/.test(w)) continue;
      w = w.replace(/[!?]+$/, "").replace(/^0-0-0/, "O-O-O").replace(/^0-0/, "O-O");
      if (w === "--" || w === "Z0") {
        toks.push({ t: "null" });
        continue;
      }
      if (w) toks.push({ t: "san", v: w });
    }
  }
  return toks;
}

/** Dzieli tokeny na partie: [{headers, moves: tokeny}] */
function splitGames(toks) {
  const games = [];
  let g = null;
  let inMoves = false;
  for (const tk of toks) {
    if (tk.t === "tag") {
      if (!g || inMoves) {
        g = { headers: {}, moves: [] };
        games.push(g);
        inMoves = false;
      }
      g.headers[tk.name] = tk.value;
    } else {
      if (!g) {
        g = { headers: {}, moves: [] };
        games.push(g);
      }
      if (tk.t === "result") {
        inMoves = true;
        g.done = true;
        g = null;
        continue;
      }
      inMoves = true;
      g.moves.push(tk);
    }
  }
  return games.filter((x) => x.moves.some((t) => t.t === "san"));
}

const cleanComment = (s) =>
  s.replace(/\[%[^\]]*\]/g, "").replace(/\s+/g, " ").trim();

/** Strzałki i pola z komentarzy Lichess ([%cal Ge2e4], [%csl Rd4]). */
function parseShapes(s) {
  const shapes = [];
  for (const m of s.matchAll(/\[%(cal|csl)\s+([^\]]*)\]/g)) {
    for (const it of m[2].split(",")) {
      const v = it.trim();
      if (m[1] === "cal" && v.length >= 5) shapes.push({ c: v[0], from: v.slice(1, 3), to: v.slice(3, 5) });
      if (m[1] === "csl" && v.length >= 3) shapes.push({ c: v[0], sq: v.slice(1, 3) });
    }
  }
  return shapes;
}

/**
 * Dodaje partie z PGN do repertuaru. Zwraca {games, added, errors: [..]}.
 */
export function importPgn(rep, text) {
  const games = splitGames(tokenize(text));
  let added = 0;
  const errors = [];

  const addNode = (fen) => {
    const k = posKey(fen);
    if (!rep.nodes[k]) rep.nodes[k] = { fen, moves: {} };
    return rep.nodes[k];
  };

  for (const [gi, game] of games.entries()) {
    const label = game.headers.ChapterName ? `„${game.headers.ChapterName}”` : `partia ${gi + 1}`;
    const variant = game.headers.Variant;
    if (variant && !/^(standard|from position)$/i.test(variant)) {
      errors.push(`${label}: odmiana ${variant} — pomijam`);
      continue;
    }
    const startFen = game.headers.FEN || START_FEN;
    let chess;
    try {
      chess = new Chess(startFen);
    } catch {
      errors.push(`${label}: błędna pozycja startowa (FEN)`);
      continue;
    }
    const rootKey = posKey(chess.fen());
    addNode(chess.fen());
    if (!rep.roots.includes(rootKey)) rep.roots.push(rootKey);

    // ramka: {fen, prevFen, lastEdge, dead}
    let cur = { fen: chess.fen(), prevFen: null, lastEdge: null, dead: false };
    const stack = [];
    for (const tk of game.moves) {
      if (tk.t === "(") {
        stack.push(cur);
        cur = { fen: cur.prevFen, prevFen: null, lastEdge: null, dead: cur.dead || !cur.prevFen };
      } else if (tk.t === ")") {
        if (stack.length) cur = stack.pop();
      } else if (tk.t === "comment") {
        if (cur.lastEdge && !cur.dead) {
          const c = cleanComment(tk.v);
          if (c && !(cur.lastEdge.comment || "").includes(c))
            cur.lastEdge.comment = cur.lastEdge.comment ? cur.lastEdge.comment + " " + c : c;
          const sh = parseShapes(tk.v);
          if (sh.length) cur.lastEdge.shapes = sh;
        }
      } else if (tk.t === "null") {
        cur.dead = true; // ruch zerowy — dalszej części wariantu nie da się zapisać
      } else if (tk.t === "san" && !cur.dead) {
        const c = new Chess(cur.fen);
        let mv;
        try {
          mv = c.move(tk.v, { strict: false });
        } catch {
          mv = null;
        }
        if (!mv) {
          errors.push(`${label}: nielegalny ruch „${tk.v}” — reszta wariantu pominięta`);
          cur.dead = true;
          continue;
        }
        const node = addNode(cur.fen);
        const uci = mv.from + mv.to + (mv.promotion || "");
        const childKey = posKey(c.fen());
        addNode(c.fen());
        let edge = node.moves[uci];
        if (!edge) {
          edge = node.moves[uci] = { san: mv.san, to: childKey };
          added++;
        }
        cur.prevFen = cur.fen;
        cur.fen = c.fen();
        cur.lastEdge = edge;
      }
    }
  }
  store.save();
  return { games: games.length, added, errors, headers: games.map((g) => g.headers) };
}

/**
 * Zgaduje kolor gracza z kształtu drzewa: po stronie gracza zwykle jeden ruch na pozycję,
 * po stronie przeciwnika — wiele odpowiedzi.
 */
export function inferColor(rep) {
  const branching = { w: [0, 0], b: [0, 0] }; // [pozycje z >1 ruchem, pozycje z ruchami]
  for (const n of Object.values(rep.nodes)) {
    const k = Object.keys(n.moves).length;
    if (!k) continue;
    const t = turnOf(n.fen);
    branching[t][1]++;
    if (k > 1) branching[t][0]++;
  }
  const ratio = (c) => (branching[c][1] ? branching[c][0] / branching[c][1] : 0);
  return ratio("w") <= ratio("b") ? "w" : "b";
}

/** Pobiera PGN studium (lub rozdziału) z Lichess. */
export async function fetchLichessStudy(url) {
  const m = url.match(/lichess\.org\/study\/([A-Za-z0-9]{8})(?:\/([A-Za-z0-9]{8}))?/);
  if (!m) throw new Error("To nie wygląda na link do studium Lichess (lichess.org/study/…)");
  const api = m[2]
    ? `https://lichess.org/api/study/${m[1]}/${m[2]}.pgn?comments=true&variations=true&clocks=false`
    : `https://lichess.org/api/study/${m[1]}.pgn?comments=true&variations=true&clocks=false`;
  const r = await fetch(api);
  if (r.status === 404) throw new Error("Nie znaleziono studium — czy jest publiczne lub „niepubliczne” (nie prywatne)?");
  if (!r.ok) throw new Error(`Lichess odpowiedział błędem ${r.status}`);
  return r.text();
}

/** Eksport repertuaru do PGN (główna linia + warianty), z każdego korzenia osobno. */
export function exportPgn(rep) {
  const out = [];
  for (const root of rep.roots) {
    const node = rep.nodes[root];
    const seen = new Set();
    const walk = (key, fullmove, white, first) => {
      const nd = rep.nodes[key];
      if (!nd || seen.has(key)) return "";
      const edges = Object.values(nd.moves);
      if (!edges.length) return "";
      seen.add(key);
      const num = (force) => (white ? `${fullmove}. ` : force ? `${fullmove}... ` : "");
      const [main, ...alts] = edges;
      let s = num(first) + main.san + (main.comment ? ` {${main.comment}}` : "");
      for (const a of alts) {
        s += ` (${num(true)}${a.san}${a.comment ? ` {${a.comment}}` : ""}`;
        const cont = walk(a.to, white ? fullmove : fullmove + 1, !white, true);
        s += (cont ? " " + cont : "") + ")";
      }
      const cont = walk(main.to, white ? fullmove : fullmove + 1, !white, alts.length > 0);
      seen.delete(key);
      return s + (cont ? " " + cont : "");
    };
    const fen = node.fen;
    const parts = fen.split(" ");
    const hdr = [`[Event "${rep.name}"]`];
    if (posKey(fen) !== posKey(START_FEN)) hdr.push(`[SetUp "1"]`, `[FEN "${fen}"]`);
    out.push(hdr.join("\n") + "\n\n" + walk(root, Number(parts[5]) || 1, parts[1] === "w", true) + " *\n");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- powtórki (SRS)

export function isUserNode(rep, node) {
  return turnOf(node.fen) === rep.color;
}

export function isDue(edge, now = Date.now()) {
  return !!edge.srs && edge.srs.due <= now;
}

export function isNew(edge) {
  return !edge.srs;
}

/** Ocena odpowiedzi. ok = trafiony za pierwszym razem. */
export function grade(edge, ok, line) {
  const now = Date.now();
  const s = edge.srs || (edge.srs = { ivl: 0, ease: 2.5, reps: 0, lapses: 0, due: now });
  if (line) s.line = line;
  s.last = now;
  if (ok) {
    if (s.ivl < 1) s.ivl = 1;
    else if (s.ivl < 3) s.ivl = 3;
    else s.ivl = Math.round(s.ivl * s.ease * (0.9 + Math.random() * 0.2));
    s.ivl = Math.min(s.ivl, 365);
    s.reps++;
    s.due = now + s.ivl * DAY;
  } else {
    s.lapses++;
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.ivl = 0;
    s.due = now + 60 * 1000; // wraca za minutę
  }
}

/** Ruch właśnie poznany: od razu do sprawdzenia. */
export function markLearned(edge, line) {
  edge.srs = { ivl: 0, ease: 2.5, reps: 0, lapses: 0, due: Date.now(), line, learned: Date.now() };
}

/** Liczniki: ruchy użytkownika, poznane, do powtórki, nowe. */
export function counts(rep, now = Date.now()) {
  let total = 0, due = 0, fresh = 0;
  for (const node of Object.values(rep.nodes)) {
    if (!isUserNode(rep, node)) continue;
    for (const e of Object.values(node.moves)) {
      total++;
      if (isNew(e)) fresh++;
      else if (e.srs.due <= now) due++;
    }
  }
  return { total, due, fresh, learned: total - fresh };
}

/**
 * Buduje linię do treningu.
 *  mode 'review' — cele: ruchy do powtórki; 'learn' — cele: nowe ruchy (max limit).
 *  prefer — poprzednia linia (lista uci), żeby nowa zaczynała się od wspólnego odcinka.
 * Zwraca {root, steps: [{key, fen, uci, san, user, target, comment, shapes}]} albo null.
 */
export function buildLine(rep, mode, { prefer = [], preferRoot = null, limit = Infinity, now = Date.now(), exclude = new Set() } = {}) {
  const isTarget = (node, uci, e) =>
    isUserNode(rep, node) && !exclude.has(node.fen + uci) && (mode === "review" ? isDue(e, now) : isNew(e));

  const memo = new Map();
  const dueIn = (key, visiting = new Set()) => {
    if (memo.has(key)) return memo.get(key);
    if (visiting.has(key)) return 0;
    const node = rep.nodes[key];
    if (!node) return 0;
    visiting.add(key);
    let n = 0;
    for (const [uci, e] of Object.entries(node.moves)) {
      if (isTarget(node, uci, e)) n++;
      n += dueIn(e.to, visiting);
      if (n > 1e6) break;
    }
    visiting.delete(key);
    memo.set(key, n);
    return n;
  };

  const roots = [...rep.roots].sort((a, b) => (a === preferRoot ? -1 : b === preferRoot ? 1 : 0));
  const root = roots.find((r) => dueIn(r) > 0);
  if (!root) return null;

  const steps = [];
  const seen = new Set();
  let key = root;
  let targets = 0;
  for (let i = 0; i < 300; i++) {
    const node = rep.nodes[key];
    if (!node || seen.has(key)) break;
    seen.add(key);
    const cands = Object.entries(node.moves).filter(
      ([uci, e]) => isTarget(node, uci, e) || dueIn(e.to) > 0
    );
    if (!cands.length) break;
    // najpierw ruch z poprzedniej linii (mniej przestawiania), potem cel w tej pozycji
    const onPrefer = root === preferRoot && i < prefer.length && steps.every((s, j) => s.uci === prefer[j]);
    const pick =
      (onPrefer && cands.find(([uci]) => uci === prefer[i])) ||
      cands.find(([uci, e]) => isTarget(node, uci, e)) ||
      cands[0];
    const [uci, e] = pick;
    const target = isTarget(node, uci, e) && targets < limit;
    if (target) targets++;
    steps.push({ key, fen: node.fen, uci, san: e.san, user: isUserNode(rep, node), target, edge: e });
    if (targets >= limit && target) break;
    key = e.to;
  }
  // przytnij za ostatnim celem
  let last = -1;
  steps.forEach((s, i) => s.target && (last = i));
  if (last < 0) return null;
  return { root, steps: steps.slice(0, last + 1) };
}

/** Zapis linii jako tekst „1. e4 e5 2. Nf3 …” */
export function lineText(rootFen, sans) {
  const parts = rootFen.split(" ");
  let n = Number(parts[5]) || 1;
  let white = parts[1] === "w";
  const out = [];
  sans.forEach((san, i) => {
    if (white) out.push(`${n}. ${san}`);
    else out.push(i === 0 ? `${n}... ${san}` : san);
    if (!white) n++;
    white = !white;
  });
  return out.join(" ");
}

/** Prognoza powtórek na kolejne dni: [dzisiaj, jutro, …] */
export function forecast(rep, days = 14) {
  const now = Date.now();
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const res = new Array(days).fill(0);
  for (const node of Object.values(rep.nodes)) {
    if (!isUserNode(rep, node)) continue;
    for (const e of Object.values(node.moves)) {
      if (!e.srs) continue;
      const d = e.srs.due <= now ? 0 : Math.floor((e.srs.due - startOfToday) / DAY);
      if (d >= 0 && d < days) res[d]++;
    }
  }
  return res;
}

/** Najczęściej mylone ruchy. */
export function weakest(rep, n = 10) {
  const out = [];
  for (const node of Object.values(rep.nodes)) {
    if (!isUserNode(rep, node)) continue;
    for (const e of Object.values(node.moves)) {
      if (e.srs && e.srs.lapses > 0) out.push({ san: e.san, srs: e.srs, fen: node.fen });
    }
  }
  return out.sort((a, b) => b.srs.lapses - a.srs.lapses || a.srs.ease - b.srs.ease).slice(0, n);
}

// ---------------------------------------------------------------- edycja

/** Dodaje ruch (obiekt chess.js) z pozycji `key`. Zwraca {edge, added}. */
export function addMove(rep, key, mv) {
  const node = rep.nodes[key];
  const uci = mv.from + mv.to + (mv.promotion || "");
  if (node.moves[uci]) return { edge: node.moves[uci], added: false };
  const childKey = posKey(mv.after);
  if (!rep.nodes[childKey]) rep.nodes[childKey] = { fen: mv.after, moves: {} };
  const edge = (node.moves[uci] = { san: mv.san, to: childKey });
  store.save();
  return { edge, added: true };
}

function reachable(rep, skip) {
  const seen = new Set();
  const stack = [...rep.roots];
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k) || !rep.nodes[k]) continue;
    seen.add(k);
    for (const [u, e] of Object.entries(rep.nodes[k].moves)) if (!(skip && skip.key === k && skip.uci === u)) stack.push(e.to);
  }
  return seen;
}

/** Co zniknie po usunięciu ruchu: {moves: liczba ruchów, userMoves, learned}. */
export function deletePreview(rep, key, uci) {
  const keep = reachable(rep, { key, uci });
  let moves = 1, userMoves = 0, learned = 0;
  const count = (node, e) => {
    if (isUserNode(rep, node)) { userMoves++; if (e.srs) learned++; }
  };
  count(rep.nodes[key], rep.nodes[key].moves[uci]);
  for (const [k, n] of Object.entries(rep.nodes)) {
    if (keep.has(k)) continue;
    for (const e of Object.values(n.moves)) { moves++; count(n, e); }
  }
  return { moves, userMoves, learned };
}

/** Usuwa ruch i wszystko, do czego nie da się już dojść inną drogą. */
export function deleteMove(rep, key, uci) {
  delete rep.nodes[key].moves[uci];
  const keep = reachable(rep);
  for (const k of Object.keys(rep.nodes)) if (!keep.has(k)) delete rep.nodes[k];
  store.save();
}

/** Pusty repertuar od pozycji wyjściowej. */
export function emptyRep(name, color) {
  const rep = store.newRep(name, color);
  const k = posKey(START_FEN);
  rep.nodes[k] = { fen: START_FEN, moves: {} };
  rep.roots.push(k);
  store.save();
  return rep;
}
