import { Chess } from "./lib/chess.js";
import { Pegasus } from "./pegasus.js";
import { BoardView } from "./board.js";
import {
  store, importPgn, inferColor, fetchLichessStudy, exportPgn, buildLine, grade, markLearned, counts,
  forecast, weakest, lineText, isUserNode, posKey, START_FEN, DAY,
  addMove, deleteMove, deletePreview, emptyRep,
} from "./repertoire.js";

const VERSION = "2026-11-07 g";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const peg = new Pegasus();
const settings = () => store.data.settings;

const SAMPLE_PGN = `[Event "Przykład: włoska"]
[Orientation "white"]

1. e4 e5 {Najczęstsza odpowiedź.} (1... c5 2. Nf3 d6 (2... Nc6 3. d4) 3. d4) (1... e6 2. d4 d5 3. Nc3) 2. Nf3 Nc6 (2... d6 3. d4) 3. Bc4 {Partia włoska.} Bc5 (3... Nf6 4. d3) 4. c3 Nf6 5. d3 *`;

// ---------------------------------------------------------------- dźwięki

let actx = null;
function beep(kind) {
  if (settings().sound === false) return;
  try {
    actx = actx || new AudioContext();
    const seq = {
      ok: [[880, 0.07]],
      move: [[600, 0.04]],
      bad: [[200, 0.22, "square"]],
      done: [[523, 0.1], [659, 0.1], [784, 0.18]],
    }[kind] || [[440, 0.1]];
    let t = actx.currentTime;
    for (const [f, d, type] of seq) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type || "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.15, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + d);
      t += d;
    }
  } catch {}
}

// ---------------------------------------------------------------- pomocnicze: zajętość pól

function occOf(chess) {
  const s = new Set();
  for (const row of chess.board()) for (const p of row) if (p) s.add(p.square);
  return s;
}

const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

function moveSquares(m) {
  const sq = [m.from, m.to];
  const rank = m.from[1];
  if (m.flags.includes("k")) sq.push("h" + rank, "f" + rank);
  if (m.flags.includes("q")) sq.push("a" + rank, "d" + rank);
  if (m.flags.includes("e")) sq.push(m.to[0] + m.from[1]);
  return sq;
}

function occAfter(base, m) {
  const s = new Set(base);
  s.delete(m.from);
  s.add(m.to);
  const rank = m.from[1];
  if (m.flags.includes("k")) { s.delete("h" + rank); s.add("f" + rank); }
  if (m.flags.includes("q")) { s.delete("a" + rank); s.add("d" + rank); }
  if (m.flags.includes("e")) s.delete(m.to[0] + m.from[1]);
  return s;
}

/** Legalne ruchy, po których zajętość pól zgadza się z planszą. */
function matchMoves(chess, occ, touched) {
  const base = occOf(chess);
  let c = chess.moves({ verbose: true }).filter((m) => setEq(occAfter(base, m), occ));
  if (c.length > 1) {
    const t = c.filter((m) => touched.has(m.to));
    if (t.length) c = t;
  }
  return c.sort((a, b) => (a.promotion === "q" ? -1 : 0) - (b.promotion === "q" ? -1 : 0));
}

const uciOf = (m) => m.from + m.to + (m.promotion || "");

class Abort extends Error {}

// ---------------------------------------------------------------- trening

class Trainer {
  constructor(board) {
    this.board = board;
    this.running = false;
    this.waiters = new Set();
  }

  physical() {
    return peg.state === "on" && !!peg.occ;
  }

  // --- wyświetlanie

  show({ last = null, arrows = [], hl = {} } = {}) {
    const b = this.board;
    b.setPosition(this.pos.fen());
    let check = null;
    if (this.pos.inCheck()) {
      for (const row of this.pos.board())
        for (const p of row) if (p && p.type === "k" && p.color === this.pos.turn()) check = p.square;
    }
    b.setHighlights({ last: last || this.lastMove, check, ...hl });
    b.setArrows(arrows);
  }

  status(main, sub = "", tone = "") {
    const el = $("#t-status");
    el.textContent = main;
    el.dataset.tone = tone;
    $("#t-sub").textContent = sub;
  }

  renderLine(steps, upto, rootFen) {
    const sans = steps.slice(0, upto).map((s) => s.san);
    $("#t-line").textContent = sans.length ? lineText(rootFen, sans) : "(pozycja wyjściowa)";
  }

  renderStats() {
    const s = this.stats;
    const c = counts(this.rep);
    $("#t-progress").innerHTML =
      `<span class="pill ok">✓ ${s.ok}</span><span class="pill bad">✗ ${s.fail}</span>` +
      (s.learned ? `<span class="pill">nowe: ${s.learned}</span>` : "") +
      `<span class="muted">do powtórki: ${c.due}</span>`;
  }

  setComment(step) {
    const el = $("#t-comment");
    el.textContent = step && step.edge.comment ? step.edge.comment : "";
    el.hidden = !el.textContent;
  }

  // --- czekanie na planszę / ekran

  _wait(setup) {
    return new Promise((resolve, reject) => {
      const w = { reject, cleanup: [] };
      const done = (v) => {
        w.cleanup.forEach((f) => f());
        this.waiters.delete(w);
        resolve(v);
      };
      w.cleanup.push(() => {});
      this.waiters.add(w);
      setup(done, (f) => w.cleanup.push(f));
    });
  }

  abort() {
    this.running = false;
    for (const w of this.waiters) {
      w.cleanup.forEach((f) => f());
      w.reject(new Abort());
    }
    this.waiters.clear();
    this.board.setInteractive(null);
    this.board.setDiff(null);
    if (this.physical()) peg.leds([]);
  }

  /** Czeka, aż zajętość pól zgodzi się z jedną z pozycji. Zwraca jej indeks. */
  waitOcc(targets, { showDiffFor = 0, ledDiff = false, quietIf = null } = {}) {
    const sets = targets.map((c) => occOf(c));
    // pozycja „jeszcze nic nie ruszone” — wtedy nie pokazuj różnic, tylko czekaj
    const quiet = quietIf && occOf(quietIf);
    return this._wait((done, onCleanup) => {
      let diffTimer = null;
      const check = () => {
        const occ = peg.occupied();
        if (!occ) return;
        clearTimeout(diffTimer);
        const i = sets.findIndex((s) => setEq(s, occ));
        if (i >= 0) {
          this.board.setDiff(null);
          return done(i);
        }
        if (quiet && setEq(quiet, occ)) {
          this.board.setDiff(null);
          return;
        }
        diffTimer = setTimeout(() => {
          const want = sets[showDiffFor];
          const missing = [...want].filter((x) => !occ.has(x));
          const extra = [...occ].filter((x) => !want.has(x));
          this.board.setDiff({ missing, extra });
          if (ledDiff) peg.leds([...missing, ...extra]);
          $("#t-sub").textContent =
            (missing.length ? `Brakuje bierki na: ${missing.join(" ")}. ` : "") +
            (extra.length ? `Zbędna bierka na: ${extra.join(" ")}.` : "");
        }, ledDiff ? 1200 : 3500);
      };
      const h = () => check();
      peg.addEventListener("occ", h);
      onCleanup(() => {
        peg.removeEventListener("occ", h);
        clearTimeout(diffTimer);
        this.board.setDiff(null);
      });
      check();
    });
  }

  /** Czeka na ruch gracza (plansza albo ekran). Zwraca obiekt ruchu chess.js (bez wykonania). */
  waitUserMove(expected) {
    if (this.physical()) {
      return this._wait((done, onCleanup) => {
        const base = occOf(this.pos);
        const touched = new Set();
        let timer = null, diffTimer = null;
        const check = (e) => {
          const occ = peg.occupied();
          if (!occ) return;
          if (e && e.detail && e.detail.square) touched.add(e.detail.square);
          clearTimeout(timer);
          clearTimeout(diffTimer);
          this.board.setDiff(null);
          if (setEq(occ, base)) {
            touched.clear();
            return;
          }
          const cands = matchMoves(this.pos, occ, touched);
          const exp = cands.find((m) => uciOf(m) === expected);
          if (exp) return done(exp);
          // inny legalny ruch — chwila zwłoki (np. roszada zaczęta od wieży)
          if (cands.length) timer = setTimeout(() => done(cands[0]), 1300);
          else
            diffTimer = setTimeout(() => {
              const missing = [...base].filter((x) => !occ.has(x));
              const extra = [...occ].filter((x) => !base.has(x));
              if (missing.length + extra.length > 2) this.board.setDiff({ missing, extra });
            }, 4000);
        };
        peg.addEventListener("occ", check);
        onCleanup(() => {
          peg.removeEventListener("occ", check);
          clearTimeout(timer);
          clearTimeout(diffTimer);
          this.board.setDiff(null);
        });
        check();
      });
    }
    return this._wait((done, onCleanup) => {
      const legal = this.pos.moves({ verbose: true });
      this.board.setInteractive((sq) => legal.filter((m) => m.from === sq).map((m) => m.to));
      this.board.onMove = (from, to) => {
        const ms = legal.filter((m) => m.from === from && m.to === to);
        const m = ms.find((x) => uciOf(x) === expected) || ms.find((x) => x.promotion === "q") || ms[0];
        if (m) done(m);
      };
      onCleanup(() => {
        this.board.setInteractive(null);
        this.board.onMove = null;
      });
    });
  }

  sleep(ms) {
    return this._wait((done, onCleanup) => {
      const t = setTimeout(done, ms);
      onCleanup(() => clearTimeout(t));
    });
  }

  // --- ruchy

  apply(m) {
    const mv = this.pos.move(uciOf(m).length > 4 ? { from: m.from, to: m.to, promotion: m.promotion } : { from: m.from, to: m.to });
    this.lastMove = [mv.from, mv.to];
    return mv;
  }

  verbose(uci) {
    return this.pos.moves({ verbose: true }).find((m) => uciOf(m) === uci);
  }

  async opponentMove(step) {
    const m = this.verbose(step.uci);
    const side = this.rep.color === "w" ? "czarne" : "białe";
    this.status(
      `Przeciwnik (${side}): ${step.san}`,
      this.physical()
        ? `Przestaw bierkę przeciwnika: ${m.from}→${m.to} (świeci na planszy${peg.rotated ? " — kieruj się diodami, nadruki są odwrócone" : ""}).`
        : ""
    );
    if (this.physical()) {
      peg.leds(moveSquares(m));
      this.show({ arrows: [{ from: m.from, to: m.to, c: "B" }] });
      const after = new Chess(this.pos.fen());
      after.move(step.uci.length > 4 ? { from: m.from, to: m.to, promotion: m.promotion } : { from: m.from, to: m.to });
      await this.waitOcc([after], { quietIf: this.pos });
      peg.leds([]);
    } else {
      this.show();
      await this.sleep(450);
    }
    this.apply(m);
    beep("move");
    this.show();
  }

  /** Cofnięcie błędnego ruchu `m` (już nie wykonanego w this.pos). */
  async takeBack(m) {
    if (!this.physical()) return;
    peg.leds(moveSquares(m), { blink: 1 });
    const wrong = new Chess(this.pos.fen());
    wrong.move({ from: m.from, to: m.to, promotion: m.promotion });
    await this.waitOcc([this.pos], { showDiffFor: 0, quietIf: wrong });
    peg.leds([]);
  }

  async showMove(step, learn) {
    const m = this.verbose(step.uci);
    for (;;) {
      this.status(learn ? `Nowy ruch: ${step.san}` : `Zagraj: ${step.san}`, learn ? "Zapamiętaj go — za chwilę sprawdzian." : "Ten ruch znasz — tylko przypomnienie.", learn ? "new" : "");
      this.setComment(learn ? step : null);
      const shapes = (step.edge.shapes || []).filter(() => learn);
      this.show({ arrows: [{ from: m.from, to: m.to, c: "G" }, ...shapes], hl: { hint: [m.from, m.to] } });
      if (this.physical() && settings().hintLeds !== false) peg.leds(moveSquares(m));
      const got = await this.waitUserMove(step.uci);
      if (uciOf(got) === step.uci) break;
      beep("bad");
      this.status(`To nie ten ruch (${got.san})`, "Cofnij go i zagraj podświetlony.", "bad");
      await this.takeBack(got);
    }
    if (this.physical()) peg.leds([]);
    this.apply(m);
    beep("move");
    this.show();
  }

  async quizMove(step, line) {
    const m = this.verbose(step.uci);
    const node = this.rep.nodes[step.key];
    const alts = Object.keys(node.moves);
    let failed = false;
    this.hintFor = () => {
      if (!failed) {
        failed = true;
        this.fail(step, line);
      }
      this.show({ arrows: [{ from: m.from, to: m.to, c: "R" }], hl: { hint: [m.from, m.to] } });
      if (this.physical()) peg.leds(moveSquares(m));
      this.status(`Poprawnie: ${step.san}`, "Zagraj ten ruch.", "bad");
    };
    this.status(`Twój ruch (${this.rep.color === "w" ? "białe" : "czarne"})`, alts.length > 1 ? `W tej pozycji masz ${alts.length} ruchy w repertuarze.` : "");
    this.setComment(null);
    this.show();
    for (;;) {
      const got = await this.waitUserMove(step.uci);
      const uci = uciOf(got);
      if (uci === step.uci) break;
      if (alts.includes(uci)) {
        this.status(`${got.san} też jest w repertuarze`, "Ale teraz ćwiczymy inny wariant — cofnij ruch.", "warn");
        this.show({ arrows: [{ from: got.from, to: got.to, c: "Y" }] });
        beep("move");
        await this.takeBack(got);
        if (!this.physical()) await this.sleep(900);
        this.status("Twój ruch", "Inny ruch z repertuaru.");
        this.show();
        continue;
      }
      beep("bad");
      if (!failed) {
        failed = true;
        this.fail(step, line);
      }
      this.show({ arrows: [{ from: got.from, to: got.to, c: "R" }, { from: m.from, to: m.to, c: "G" }], hl: { bad: [got.from, got.to] } });
      this.status(`Źle: ${got.san}. Poprawnie: ${step.san}`, this.physical() ? "Cofnij ruch (miga na planszy), potem zagraj poprawny." : "Zagraj poprawny ruch.", "bad");
      if (this.physical()) await this.takeBack(got);
      else await this.sleep(1300);
      if (this.physical()) peg.leds(moveSquares(m));
      this.show({ arrows: [{ from: m.from, to: m.to, c: "G" }], hl: { hint: [m.from, m.to] } });
      this.status(`Zagraj: ${step.san}`, `(zagrałeś ${got.san})`, "bad");
    }
    this.hintFor = null;
    if (this.physical()) peg.leds([]);
    this.apply(m);
    if (!failed) {
      grade(step.edge, true, line);
      store.logReview(this.rep, true);
      this.stats.ok++;
      beep("ok");
      this.show({ hl: { good: [m.from, m.to] } });
    } else this.show();
    this.setComment(step);
    this.renderStats();
  }

  fail(step, line) {
    grade(step.edge, false, line);
    store.logReview(this.rep, false);
    this.stats.fail++;
    this.retry.add(step.fen + step.uci);
    this.renderStats();
  }

  // --- linie

  positionsOf(rootFen, ucis) {
    const out = [new Chess(rootFen)];
    for (const u of ucis) {
      const c = new Chess(out[out.length - 1].fen());
      c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(c);
    }
    return out;
  }

  /** Ustawia planszę w pozycji po `k` ruchach nowej linii (cofanie z diodami). */
  async navigate(rootFen, steps, k) {
    const ucis = steps.map((s) => s.uci);
    const positions = this.positionsOf(rootFen, this.played);
    let cur = this.played.length;
    if (!this.physical()) return k;
    for (let first = true; ; first = false) {
      const lim = Math.min(cur, k);
      // pozycje, do których można dojść: od korzenia do bieżącej (potem już tylko wcześniejsze)
      const targets = positions.slice(0, first ? cur + 1 : cur);
      // przy ustawianiu: różnice względem celu; przy cofaniu: względem następnego kroku
      const diffFor = this.synced ? targets.length - 1 : Math.min(lim, targets.length - 1);
      const idx = await this.waitOcc(targets, { showDiffFor: diffFor, ledDiff: !this.synced, quietIf: first ? null : positions[cur] });
      if (!this.synced) {
        this.synced = true;
        peg.leds([]);
      }
      cur = idx;
      if (cur <= k) {
        peg.leds([]);
        this.played = this.played.slice(0, cur);
        // jeżeli pozycja startowa planszy jest dalej niż wspólny odcinek, nic więcej nie trzeba
        return Math.min(cur, ucis.length);
      }
      // cofnij ruch played[cur-1]
      const before = positions[cur - 1];
      const u = this.played[cur - 1];
      const m = before.moves({ verbose: true }).find((x) => uciOf(x) === u);
      peg.leds(moveSquares(m), { blink: 1 });
      this.pos = new Chess(positions[cur].fen());
      this.lastMove = null;
      this.show({ arrows: [{ from: m.to, to: m.from, c: "Y" }] });
      this.status(`Cofnij: ${m.san}`, `Wracamy ${cur - k} ${cur - k === 1 ? "ruch" : "ruchy"} do rozgałęzienia (miga na planszy).`, "warn");
    }
  }

  async playLine(line, phase) {
    const rootFen = this.rep.nodes[line.root].fen;
    if (this.root !== line.root) {
      this.root = line.root;
      this.played = [];
      this.synced = false;
    }
    const steps = line.steps;
    let k = 0;
    while (k < this.played.length && k < steps.length && this.played[k] === steps[k].uci) k++;
    k = Math.min(k, steps.findIndex((s) => s.target)); // wróć co najmniej przed pierwszy cel
    if (this.physical()) {
      if (!this.synced) this.status("Ustaw pozycję", "Ustaw bierki jak na ekranie. Świecą się pola, które się nie zgadzają.", "warn");
      const start = this.positionsOf(rootFen, steps.slice(0, k).map((s) => s.uci))[k];
      if (!this.synced && this.played.length === 0) {
        this.pos = new Chess(start.fen());
        this.lastMove = null;
        this.show();
      }
      k = await this.navigate(rootFen, steps, k);
    }
    this.pos = this.positionsOf(rootFen, steps.slice(0, k).map((s) => s.uci))[k];
    this.lastMove = null;
    this.show();
    const sans = steps.map((s) => s.san);
    for (let i = k; i < steps.length; i++) {
      if (!this.running) throw new Abort();
      const step = steps[i];
      this.renderLine(steps, i, rootFen);
      const line = lineText(rootFen, sans.slice(0, i + 1));
      if (!step.user) await this.opponentMove(step);
      else if (step.target && phase === "show") {
        await this.showMove(step, true);
        markLearned(step.edge, line);
        store.logReview(this.rep, true, true);
        this.stats.learned++;
        this.renderStats();
      } else if (step.target) await this.quizMove(step, line);
      else await this.showMove(step, false);
      this.played = steps.slice(0, i + 1).map((s) => s.uci);
      this.renderLine(steps, i + 1, rootFen);
    }
    store.save();
    await this.sleep(phase === "show" ? 400 : 700);
  }

  async run(rep, mode) {
    this.rep = rep;
    this.mode = mode;
    this.running = true;
    this.stats = { ok: 0, fail: 0, learned: 0 };
    this.retry = new Set();
    this.root = null;
    this.played = [];
    this.synced = false;
    this.lastMove = null;
    this.board.setOrientation(rep.color);
    $("#t-title").textContent = `${rep.name} — ${mode === "learn" ? "nowe ruchy" : "powtórki"}`;
    $("#t-hint").hidden = mode === "learn";
    this.renderStats();
    let wake = null;
    try {
      wake = await navigator.wakeLock?.request("screen");
    } catch {}
    let newLeft = Number(settings().newPerSession) || 10;
    let retryRound = false;
    try {
      for (;;) {
        let line;
        if (mode === "learn") {
          line = buildLine(rep, "learn", { prefer: this.played, preferRoot: this.root, limit: newLeft });
          if (!line) break;
          const n = line.steps.filter((s) => s.target).length;
          await this.playLine(line, "show");
          newLeft -= n;
          // od razu sprawdzian tej samej linii
          this.status("Sprawdzian", "Teraz bez podpowiedzi.", "new");
          await this.sleep(900);
          const quiz = { root: line.root, steps: line.steps.map((s) => ({ ...s })) };
          await this.playLine(quiz, "quiz");
          if (newLeft <= 0) break;
        } else {
          line = buildLine(rep, "review", {
            prefer: this.played, preferRoot: this.root, exclude: retryRound ? new Set() : this.retry,
            now: Date.now() + (retryRound ? 5 * 60 * 1000 : 0),
          });
          if (!line) {
            if (!retryRound && this.retry.size) {
              retryRound = true;
              this.retry.clear();
              this.status("Poprawka błędów", "Jeszcze raz ruchy, które się nie udały.", "warn");
              await this.sleep(1200);
              continue;
            }
            break;
          }
          await this.playLine(line, "quiz");
        }
      }
      this.finish();
    } catch (e) {
      if (!(e instanceof Abort)) {
        console.error(e);
        this.status("Błąd", String(e.message || e), "bad");
      }
    } finally {
      this.running = false;
      store.save();
      try { wake && wake.release(); } catch {}
      if (this.physical()) peg.leds([]);
    }
  }

  finish() {
    const s = this.stats;
    const c = counts(this.rep);
    beep("done");
    this.board.setArrows([]);
    if (this.mode === "learn")
      this.status(s.learned ? `Poznane nowe ruchy: ${s.learned}` : "Brak nowych ruchów", `Sprawdzian: ✓ ${s.ok}  ✗ ${s.fail}. Nowych zostało: ${c.fresh}.`, "good");
    else
      this.status(s.ok + s.fail ? "Powtórki zrobione 🎉" : "Nic do powtórki", s.ok + s.fail ? `✓ ${s.ok}  ✗ ${s.fail}  (${Math.round((100 * s.ok) / (s.ok + s.fail))}%)` : `Następne powtórki: ${nextDueText(this.rep)}. Możesz poznać nowe ruchy (${c.fresh}).`, "good");
    this.renderStats();
    $("#t-stop").textContent = "Zamknij";
    if (this.physical()) peg.leds([]);
  }
}

function nextDueText(rep) {
  let min = Infinity;
  for (const node of Object.values(rep.nodes))
    if (isUserNode(rep, node))
      for (const e of Object.values(node.moves)) if (e.srs && e.srs.due < min) min = e.srs.due;
  if (min === Infinity) return "brak";
  return whenText(min);
}

function whenText(t) {
  const d = t - Date.now();
  if (d <= 0) return "teraz";
  if (d < 3600e3) return `za ${Math.max(1, Math.round(d / 60e3))} min`;
  if (d < DAY) return `za ${Math.round(d / 3600e3)} h`;
  const days = Math.round(d / DAY);
  return days === 1 ? "jutro" : `za ${days} dni`;
}

// ---------------------------------------------------------------- widoki

let trainBoard, browseBoard, trainer;

function go(view) {
  $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));
  $$("nav button[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.body.dataset.view = view;
  if (view === "home") renderHome();
  if (view === "stats") renderStats();
  if (view === "settings") renderSettings();
  window.scrollTo(0, 0);
}

function renderHome() {
  const list = $("#rep-list");
  const reps = store.data.reps;
  if (!reps.length) {
    list.innerHTML = `<div class="empty card">
      <h3>Nie masz jeszcze repertuaru</h3>
      <p>Zaimportuj PGN albo studium z Lichess. Możesz też zacząć od małego przykładu.</p>
      <div class="row"><button class="primary" data-act="import">Importuj repertuar</button>
      <button data-act="sample">Dodaj przykład (włoska, białe)</button></div></div>`;
  } else {
    list.innerHTML = reps
      .map((r) => {
        const c = counts(r);
        const pct = c.total ? Math.round((100 * c.learned) / c.total) : 0;
        return `<div class="card rep" data-id="${r.id}">
          <div class="rep-head">
            <span class="color-dot ${r.color}"></span>
            <h3>${esc(r.name)}</h3>
            <span class="muted">${r.color === "w" ? "białe" : "czarne"} · ${c.total} ruchów</span>
          </div>
          <div class="bar"><span style="width:${pct}%"></span></div>
          <div class="muted small">poznane ${c.learned}/${c.total} · nowe ${c.fresh} · następne powtórki: ${c.due ? "teraz" : nextDueText(r)}</div>
          <div class="row">
            <button class="primary" data-act="review" ${c.due ? "" : "disabled"}>Powtórki <b>${c.due}</b></button>
            <button class="accent" data-act="learn" ${c.fresh ? "" : "disabled"}>Nowe ruchy <b>${Math.min(c.fresh, Number(settings().newPerSession) || 10)}</b></button>
            <button data-act="browse">Edytuj</button>
            <button data-act="more" class="ghost" aria-label="Więcej">⋯</button>
          </div>
          <div class="more-menu" hidden>
            <button data-act="add">Dodaj z PGN / Lichess</button>
            <button data-act="export">Eksport PGN</button>
            <button data-act="rename">Zmień nazwę</button>
            <button data-act="reset">Wyzeruj postępy</button>
            <button data-act="delete" class="danger">Usuń</button>
          </div>
        </div>`;
      })
      .join("") + `<button class="card add-card" data-act="import">+ Nowy repertuar / import</button>`;
  }
  const totalDue = reps.reduce((n, r) => n + counts(r).due, 0);
  $("#home-summary").textContent = reps.length
    ? totalDue ? `Do powtórki dzisiaj: ${totalDue}` : "Wszystkie powtórki zrobione."
    : "";
}

async function onHomeClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const card = btn.closest(".rep");
  const rep = card && store.rep(card.dataset.id);
  const act = btn.dataset.act;
  if (act === "import") return openImport(null);
  if (act === "sample") {
    const r = store.newRep("Przykład: włoska", "w");
    importPgn(r, SAMPLE_PGN);
    await store.saveNow();
    return renderHome();
  }
  if (!rep) return;
  if (act === "review" || act === "learn") return startTraining(rep, act);
  if (act === "browse") return openBrowse(rep);
  if (act === "more") return (card.querySelector(".more-menu").hidden ^= true);
  if (act === "add") return openImport(rep);
  if (act === "export") return download(`${rep.name}.pgn`, exportPgn(rep), "application/x-chess-pgn");
  if (act === "rename") {
    const n = prompt("Nowa nazwa:", rep.name);
    if (n) { rep.name = n.trim(); store.save(); renderHome(); }
    return;
  }
  if (act === "reset") {
    if (!confirm(`Wyzerować postępy w „${rep.name}”? Ruchy zostaną, ale wszystkie będą znów nowe.`)) return;
    for (const n of Object.values(rep.nodes)) for (const ed of Object.values(n.moves)) delete ed.srs;
    store.save();
    return renderHome();
  }
  if (act === "delete") {
    if (!confirm(`Usunąć repertuar „${rep.name}”? Tego nie da się cofnąć (chyba że masz kopię zapasową).`)) return;
    store.deleteRep(rep.id);
    renderHome();
  }
}

function download(name, text, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name.replace(/[\\/:*?"<>|]/g, "_");
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// --- import

let importTarget = null;

function openImport(rep) {
  importTarget = rep;
  $("#imp-new").hidden = !!rep;
  $("#imp-title").textContent = rep ? `Dodaj do: ${rep.name}` : "Nowy repertuar";
  $("#imp-result").innerHTML = "";
  go("import");
}

async function doImport() {
  const out = $("#imp-result");
  const src = $("input[name=src]:checked").value;
  const btn = $("#imp-go");
  btn.disabled = true;
  out.innerHTML = `<p class="muted">Wczytuję…</p>`;
  try {
    let text;
    if (src === "lichess") text = await fetchLichessStudy($("#imp-url").value.trim());
    else if (src === "file") {
      const f = $("#imp-file").files[0];
      if (!f) throw new Error("Wybierz plik PGN.");
      text = await f.text();
    } else text = $("#imp-text").value;
    if (!text || !text.trim()) throw new Error("Pusty PGN.");

    let rep = importTarget;
    let guessed = false;
    if (!rep) {
      let color = $("#imp-color").value;
      let guess = false;
      if (color === "auto") {
        const o = (text.match(/\[Orientation\s+"(\w+)"\]/) || [])[1];
        if (o) color = o === "black" ? "b" : "w";
        else {
          const tmp = { roots: [], nodes: {} };
          importPgn(tmp, text);
          color = inferColor(tmp);
          guess = true;
        }
      }
      let name = $("#imp-name").value.trim();
      if (!name) name = (text.match(/\[StudyName\s+"([^"]+)"\]/) || text.match(/\[Event\s+"([^"]+)"\]/) || [])[1] || "Mój repertuar";
      rep = store.newRep(name, color);
      guessed = guess;
    }
    const res = importPgn(rep, text);
    await store.saveNow();
    const c = counts(rep);
    out.innerHTML = `<div class="card ok-card">
      <b>Gotowe.</b> Wczytano ${res.games} ${res.games === 1 ? "partię/rozdział" : "partii/rozdziałów"}, nowych ruchów: ${res.added}.
      Twoich ruchów do nauki w repertuarze „${esc(rep.name)}” (${rep.color === "w" ? "białe" : "czarne"}): ${c.total}.
      ${guessed ? `<p class="small">Kolor rozpoznany po kształcie drzewa wariantów — jeśli się nie zgadza, usuń repertuar i zaimportuj z wybranym kolorem.</p>` : ""}
      ${res.errors.length ? `<details><summary>Pominięte fragmenty (${res.errors.length})</summary><ul>${res.errors.slice(0, 30).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
      <div class="row"><button class="primary" data-go="home">Do repertuarów</button></div></div>`;
    if (!importTarget) {
      $("#imp-name").value = "";
      importTarget = rep;
      $("#imp-new").hidden = true;
      $("#imp-title").textContent = `Dodaj do: ${rep.name}`;
    }
  } catch (e) {
    out.innerHTML = `<div class="card bad-card">${esc(e.message || e)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// --- trening

function startTraining(rep, mode) {
  go("train");
  $("#t-stop").textContent = "Zakończ";
  $("#t-comment").hidden = true;
  $("#t-line").textContent = "";
  if (!peg.occ || peg.state !== "on")
    $("#t-mode").textContent = "Bez planszy — ruchy na ekranie (dotknij bierkę, potem pole).";
  else $("#t-mode").textContent = `Plansza: ${peg.device?.name || "Pegasus"}`;
  trainer.run(rep, mode);
}

// --- edytor (przeglądanie, dodawanie, usuwanie, komentarze)

const browse = { rep: null, path: [], root: null };

function openBrowse(rep) {
  browse.rep = rep;
  browse.path = [];
  browse.root = rep.roots[0];
  browseBoard.setOrientation(rep.color);
  go("browse");
  renderBrowse();
}

/** Bieżąca pozycja edytora: {chess, key, lastEdge, last, sans}. Ucina ścieżkę, jeśli ruch zniknął. */
function browseState() {
  const rep = browse.rep;
  const chess = new Chess(rep.nodes[browse.root].fen);
  let key = browse.root, lastEdge = null, last = null;
  const sans = [];
  for (let i = 0; i < browse.path.length; i++) {
    const u = browse.path[i];
    const e = rep.nodes[key] && rep.nodes[key].moves[u];
    if (!e) { browse.path.length = i; break; }
    const mv = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    last = [mv.from, mv.to];
    sans.push(mv.san);
    lastEdge = e;
    key = e.to;
  }
  return { chess, key, lastEdge, last, sans };
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

/** Ruch w edytorze: przejście do istniejącego albo dodanie nowego. */
function browsePlay(mv) {
  const rep = browse.rep;
  const { key } = browseState();
  const node = rep.nodes[key];
  const userBefore = isUserNode(rep, node) ? Object.values(node.moves).map((e) => e.san) : [];
  const { added } = addMove(rep, key, mv);
  browse.path.push(uciOf(mv));
  if (added) {
    toast(userBefore.length ? `Dodano ${mv.san} — w tej pozycji masz teraz też: ${userBefore.join(", ")}` : `Dodano ruch ${mv.san}`);
    beep("ok");
  } else beep("move");
  renderBrowse();
}

function renderBrowse() {
  const rep = browse.rep;
  const rootFen = rep.nodes[browse.root].fen;
  const { chess, key, lastEdge, last, sans } = browseState();
  browse.chess = chess;
  browseBoard.setPosition(chess.fen());
  browseBoard.setHighlights({ last });
  const node = rep.nodes[key];
  const edges = Object.entries(node.moves);
  const user = isUserNode(rep, node);
  browseBoard.setArrows(edges.map(([u]) => ({ from: u.slice(0, 2), to: u.slice(2, 4), c: user ? "G" : "B" })));
  const legal = chess.moves({ verbose: true });
  browseBoard.setInteractive((sq) => legal.filter((m) => m.from === sq).map((m) => m.to));
  browseBoard.onMove = (from, to) => {
    const ms = legal.filter((m) => m.from === from && m.to === to);
    if (!ms.length) return;
    let m = ms[0];
    if (ms.length > 1) {
      const p = (prompt("Promocja na: h (hetman), w (wieża), g (goniec), s (skoczek)", "h") || "h").toLowerCase()[0];
      m = ms.find((x) => x.promotion === ({ h: "q", w: "r", g: "b", s: "n" }[p] || "q")) || ms[0];
    }
    browsePlay(m);
  };

  $("#b-title").textContent = rep.name;
  $("#b-line").textContent = sans.length ? lineText(rootFen, sans) : "(pozycja wyjściowa)";
  $("#b-roots").hidden = rep.roots.length < 2;
  $("#b-roots").innerHTML = rep.roots.map((r, i) => `<option value="${esc(r)}" ${r === browse.root ? "selected" : ""}>Pozycja startowa ${i + 1}${r === posKey(START_FEN) ? " (zwykła)" : ""}</option>`).join("");

  const cbox = $("#b-comment-box");
  cbox.hidden = !lastEdge;
  if (lastEdge) {
    $("#b-comment-label").textContent = `Komentarz do ruchu ${sans[sans.length - 1]}`;
    const ta = $("#b-comment");
    if (document.activeElement !== ta) ta.value = lastEdge.comment || "";
  }

  $("#b-moves").innerHTML =
    `<p class="muted small">${user ? "Twoje ruchy" : "Ruchy przeciwnika"} — ${edges.length ? "stuknij, żeby przejść" : "brak"}. Nowy ruch dodasz, wykonując go na szachownicy${peg.state === "on" ? " (ekran albo Pegasus)" : ""}.</p>` +
    edges
      .map(([u, e]) => {
        let st = "";
        if (user) st = !e.srs ? `<span class="pill">nowy</span>` : e.srs.due <= Date.now() ? `<span class="pill bad">do powtórki</span>` : `<span class="pill ok">${whenText(e.srs.due)}</span>`;
        return `<div class="move-row"><button class="move-btn" data-uci="${u}"><b>${esc(e.san)}</b> ${st}${e.srs && e.srs.lapses ? `<span class="muted small">błędy: ${e.srs.lapses}</span>` : ""}${e.comment ? `<span class="muted small" title="${esc(e.comment)}">💬</span>` : ""}</button><button class="ghost del" data-del="${u}" aria-label="Usuń ${esc(e.san)}" title="Usuń ruch i dalsze">🗑</button></div>`;
      })
      .join("");
  syncBrowsePhysical();
}

function browseDelete(uci) {
  const rep = browse.rep;
  const { key } = browseState();
  const e = rep.nodes[key].moves[uci];
  const p = deletePreview(rep, key, uci);
  const n = p.moves - 1;
  const word = n === 1 ? "dalszy ruch" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "dalsze ruchy" : "dalszych ruchów";
  const more = n > 0 ? ` i ${n} ${word} (Twoich: ${p.userMoves}${p.learned ? `, w tym poznanych: ${p.learned}` : ""})` : "";
  if (!confirm(`Usunąć ${e.san}${more}?\n\nPozycje osiągalne inną kolejnością ruchów zostaną.`)) return;
  deleteMove(rep, key, uci);
  toast(`Usunięto ${e.san}`);
  renderBrowse();
}

// Pegasus w edytorze: ruch na planszy = przejście/dodanie, cofnięcie na planszy = krok wstecz.
const bphys = { touched: new Set(), timer: null };

function syncBrowsePhysical() {
  bphys.touched.clear();
  clearTimeout(bphys.timer);
  onBrowseOcc();
}

function onBrowseOcc(e) {
  if (document.body.dataset.view !== "browse" || peg.state !== "on" || !browse.chess) return;
  const occ = peg.occupied();
  if (!occ) return;
  if (e && e.detail && e.detail.square) bphys.touched.add(e.detail.square);
  clearTimeout(bphys.timer);
  const chess = browse.chess;
  if (setEq(occ, occOf(chess))) {
    bphys.touched.clear();
    browseBoard.setDiff(null);
    return;
  }
  // cofnięcie ruchu na planszy
  if (browse.path.length) {
    const prev = new Chess(browse.rep.nodes[browse.root].fen);
    for (const u of browse.path.slice(0, -1)) prev.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    if (setEq(occ, occOf(prev))) {
      browse.path.pop();
      return renderBrowse();
    }
  }
  const cands = matchMoves(chess, occ, bphys.touched);
  if (cands.length) {
    // ruch z repertuaru od razu, nowy po chwili (np. roszada zaczęta od wieży)
    const node = browse.rep.nodes[browseState().key];
    const known = cands.find((m) => node.moves[uciOf(m)]);
    if (known) return browsePlay(known);
    bphys.timer = setTimeout(() => browsePlay(cands[0]), 1300);
    return;
  }
  bphys.timer = setTimeout(() => {
    const want = occOf(chess);
    browseBoard.setDiff({ missing: [...want].filter((x) => !occ.has(x)), extra: [...occ].filter((x) => !want.has(x)) });
  }, 3000);
}

// --- statystyki

function renderStats() {
  const reps = store.data.reps;
  const sel = $("#s-rep");
  const prev = sel.value;
  sel.innerHTML = `<option value="">Wszystkie</option>` + reps.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  sel.value = reps.some((r) => r.id === prev) ? prev : "";
  const chosen = sel.value ? [store.rep(sel.value)] : reps;
  const ids = new Set(chosen.map((r) => r.id));

  const tot = { total: 0, learned: 0, due: 0, fresh: 0 };
  const fc = new Array(14).fill(0);
  let weak = [];
  for (const r of chosen) {
    const c = counts(r);
    for (const k in tot) tot[k] += c[k];
    forecast(r, 14).forEach((v, i) => (fc[i] += v));
    weak = weak.concat(weakest(r, 10).map((w) => ({ ...w, rep: r })));
  }
  weak.sort((a, b) => b.srs.lapses - a.srs.lapses).splice(10);

  const log = store.data.log.filter((l) => ids.has(l.rep) && !l.learn);
  const since30 = Date.now() - 30 * DAY;
  const l30 = log.filter((l) => l.t >= since30);
  const acc = l30.length ? Math.round((100 * l30.filter((l) => l.ok).length) / l30.length) : null;

  // ostatnie 14 dni
  const days = [];
  const today0 = new Date().setHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    const d0 = today0 - i * DAY;
    const ls = log.filter((l) => l.t >= d0 && l.t < d0 + DAY);
    days.push({ d: new Date(d0), ok: ls.filter((l) => l.ok).length, bad: ls.filter((l) => !l.ok).length });
  }
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].ok + days[i].bad) streak++;
    else if (i !== days.length - 1) break;
  }

  $("#s-tiles").innerHTML = [
    ["Ruchy w repertuarze", tot.total],
    ["Poznane", tot.learned],
    ["Do powtórki teraz", tot.due],
    ["Nowe", tot.fresh],
    ["Skuteczność (30 dni)", acc === null ? "—" : acc + "%"],
    ["Dni z rzędu", streak],
  ].map(([k, v]) => `<div class="tile"><div class="tile-v">${v}</div><div class="tile-k">${k}</div></div>`).join("");

  const dn = (d) => d.toLocaleDateString("pl-PL", { weekday: "short" });
  const maxF = Math.max(1, ...fc);
  $("#s-forecast").innerHTML = fc
    .map((v, i) => {
      const d = new Date(today0 + i * DAY);
      return `<div class="col" title="${v}"><span class="v">${v || ""}</span><div class="b" style="height:${(100 * v) / maxF}%"></div><span class="k">${i === 0 ? "dziś" : i === 1 ? "jutro" : dn(d) + " " + d.getDate()}</span></div>`;
    })
    .join("");

  const maxH = Math.max(1, ...days.map((d) => d.ok + d.bad));
  $("#s-history").innerHTML = days
    .map((d) => `<div class="col" title="✓ ${d.ok}  ✗ ${d.bad}"><span class="v">${d.ok + d.bad || ""}</span>
      <div class="stack" style="height:${(100 * (d.ok + d.bad)) / maxH}%"><div class="b bad" style="flex:${d.bad}"></div><div class="b" style="flex:${d.ok}"></div></div>
      <span class="k">${dn(d.d)} ${d.d.getDate()}</span></div>`)
    .join("");

  $("#s-weak").innerHTML = weak.length
    ? weak.map((w) => `<li><b>${esc(w.san)}</b> — błędy: ${w.srs.lapses}, następna powtórka ${whenText(w.srs.due)}<div class="muted small">${esc(w.srs.line || "")}${chosen.length > 1 ? " · " + esc(w.rep.name) : ""}</div></li>`).join("")
    : `<li class="muted">Brak błędów — albo jeszcze nic nie powtarzałeś.</li>`;
}

// --- ustawienia

function renderSettings() {
  const s = settings();
  $("#set-version").textContent = `Wersja aplikacji: ${VERSION}`;
  $("#set-new").value = s.newPerSession || 10;
  $("#set-sound").checked = s.sound !== false;
  $("#set-hintleds").checked = s.hintLeds !== false;
  $("#set-rotated").checked = !!s.rotated;
  $("#set-bt").textContent = Pegasus.supported()
    ? "Web Bluetooth dostępny ✓"
    : "Ta przeglądarka nie obsługuje Web Bluetooth — użyj Chrome na Androidzie (strona musi być otwarta przez https).";
}

// --- plansza: status

function renderPeg() {
  const el = $("#peg-btn");
  const st = peg.state;
  el.dataset.state = st;
  const batt = peg.battery ? ` · ${peg.battery.pct}%${peg.battery.charging ? "⚡" : ""}` : "";
  el.textContent =
    st === "on" ? `● ${peg.device?.name || "Pegasus"}${batt}`
    : st === "connecting" ? "● Łączę…"
    : st === "lost" ? "● Utracono — łączę ponownie…"
    : "Połącz planszę";
  $("#peg-test-leds").disabled = st !== "on";
}

function pegLog(msg, tone = "") {
  const li = document.createElement("li");
  li.textContent = msg;
  if (tone) li.dataset.tone = tone;
  $("#peg-log").append(li);
}

const BT_ERRORS = {
  NotFoundError: "Nie wybrano planszy z listy. Jeśli lista była pusta: włącz Bluetooth i lokalizację na tablecie, w ustawieniach Androida daj Chrome uprawnienie „Urządzenia w pobliżu” (i „Lokalizacja”), rozłącz telefon z aplikacją DGT i sprawdź, czy plansza jest włączona (miga niebieska dioda).",
  SecurityError: "Przeglądarka zablokowała Bluetooth dla tej strony. Sprawdź w Chrome: ⋮ → Ustawienia → Ustawienia witryn → Bluetooth.",
  NotAllowedError: "Brak zgody na Bluetooth. Sprawdź w Chrome: ⋮ → Ustawienia → Ustawienia witryn → Bluetooth.",
  NetworkError: "Plansza nie odpowiada. Wyłącz i włącz planszę, upewnij się, że telefon z aplikacją DGT jest rozłączony, i spróbuj ponownie.",
  NotSupportedError: "To urządzenie nie wygląda na Pegasusa (brak usługi UART).",
};

async function onPegClick() {
  if (peg.state === "on" || peg.state === "lost") {
    if (confirm("Rozłączyć planszę?")) peg.disconnect();
    return;
  }
  const dlg = $("#peg-dialog");
  $("#peg-log").replaceChildren();
  if (!dlg.open) dlg.showModal();
  if (!Pegasus.supported()) {
    const ua = navigator.userAgent;
    pegLog("Ta przeglądarka nie obsługuje Web Bluetooth.", "bad");
    if (/SamsungBrowser/.test(ua)) pegLog("To jest Samsung Internet — otwórz ten adres w Google Chrome.", "bad");
    else if (/Firefox|FxiOS/.test(ua)) pegLog("Firefox nie obsługuje Bluetooth — otwórz ten adres w Google Chrome.", "bad");
    else if (!isSecureContext) pegLog("Strona nie jest otwarta przez https.", "bad");
    else pegLog("Otwórz ten adres w Google Chrome na Androidzie (aktualna wersja).", "bad");
    pegLog(`Przeglądarka: ${ua}`, "muted");
    return;
  }
  try {
    await peg.pick();
    setTimeout(() => dlg.open && dlg.close(), 1200);
  } catch (e) {
    pegLog(BT_ERRORS[e.name] || `Błąd: ${e.message || e}`, "bad");
    pegLog(`(${e.name}: ${e.message})`, "muted");
    try {
      if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability()))
        pegLog("Tablet zgłasza, że Bluetooth jest wyłączony lub niedostępny.", "bad");
    } catch {}
    if (peg.state === "connecting") peg.disconnect();
    renderPeg();
  }
}

// ---------------------------------------------------------------- start

async function main() {
  await store.load();
  peg.rotated = !!settings().rotated;

  trainBoard = new BoardView($("#t-board"));
  browseBoard = new BoardView($("#b-board"));
  trainer = new Trainer(trainBoard);
  trainBoard.setPosition(START_FEN);

  $("nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (!b) return;
    if (trainer.running && !confirm("Przerwać trening?")) return;
    if (trainer.running) trainer.abort();
    go(b.dataset.view);
  });
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-go]");
    if (g) go(g.dataset.go);
  });
  $("#rep-list").addEventListener("click", onHomeClick);

  $("#imp-go").addEventListener("click", doImport);
  $$("input[name=src]").forEach((r) =>
    r.addEventListener("change", () => $$(".src-pane").forEach((p) => (p.hidden = p.dataset.src !== $("input[name=src]:checked").value)))
  );

  $("#t-stop").addEventListener("click", () => {
    if (trainer.running) trainer.abort();
    go("home");
  });
  $("#t-hint").addEventListener("click", () => trainer.hintFor && trainer.hintFor());
  $("#t-flip").addEventListener("click", () => trainBoard.setOrientation(trainBoard.orientation === "w" ? "b" : "w"));

  $("#b-moves").addEventListener("click", (e) => {
    const d = e.target.closest("[data-del]");
    if (d) return browseDelete(d.dataset.del);
    const b = e.target.closest("[data-uci]");
    if (!b) return;
    browse.path.push(b.dataset.uci);
    renderBrowse();
  });
  $("#b-comment").addEventListener("input", (e) => {
    const { lastEdge } = browseState();
    if (!lastEdge) return;
    const v = e.target.value.trim();
    if (v) lastEdge.comment = v;
    else delete lastEdge.comment;
    store.save();
  });
  $("#b-comment").addEventListener("change", () => renderBrowse());
  peg.addEventListener("occ", onBrowseOcc);
  $("#imp-empty").addEventListener("click", () => {
    const name = $("#imp-name").value.trim() || "Nowy repertuar";
    let color = $("#imp-color").value;
    if (color === "auto") color = "w";
    const rep = emptyRep(name, color);
    $("#imp-name").value = "";
    openBrowse(rep);
    toast("Pusty repertuar — wykonuj ruchy na szachownicy, żeby je dodać");
  });
  $("#b-back").addEventListener("click", () => { browse.path.pop(); renderBrowse(); });
  $("#b-start").addEventListener("click", () => { browse.path = []; renderBrowse(); });
  $("#b-roots").addEventListener("change", (e) => { browse.root = e.target.value; browse.path = []; renderBrowse(); });

  $("#s-rep").addEventListener("change", renderStats);

  $("#set-new").addEventListener("change", (e) => { settings().newPerSession = Math.max(1, Math.min(50, Number(e.target.value) || 10)); store.save(); });
  $("#set-sound").addEventListener("change", (e) => { settings().sound = e.target.checked; store.save(); });
  $("#set-hintleds").addEventListener("change", (e) => { settings().hintLeds = e.target.checked; store.save(); });
  $("#set-rotated").addEventListener("change", (e) => {
    settings().rotated = e.target.checked;
    peg.rotated = e.target.checked;
    store.save();
    peg.dump();
  });
  $("#set-backup").addEventListener("click", () =>
    download(`repertuar-kopia-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(store.data), "application/json")
  );
  $("#set-restore").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.reps)) throw new Error("To nie jest kopia zapasowa tej aplikacji.");
      if (!confirm(`Przywrócić kopię (${d.reps.length} repertuarów)? Obecne dane zostaną zastąpione.`)) return;
      store.data = { reps: [], log: [], settings: {}, ...d };
      await store.saveNow();
      alert("Przywrócono.");
      go("home");
    } catch (err) {
      alert("Nie udało się: " + err.message);
    }
    e.target.value = "";
  });

  $("#peg-btn").addEventListener("click", onPegClick);
  $("#peg-test-leds").addEventListener("click", async () => {
    await peg.leds(["d4", "e4", "d5", "e5"]);
    setTimeout(() => peg.leds([]), 1500);
  });
  peg.addEventListener("state", renderPeg);
  peg.addEventListener("log", (e) => $("#peg-dialog").open && pegLog(e.detail));
  $("#peg-close").addEventListener("click", () => $("#peg-dialog").close());
  $("#peg-retry").addEventListener("click", onPegClick);
  peg.addEventListener("battery", renderPeg);
  renderPeg();

  // ponowne połączenie z wcześniej wybraną planszą (jeśli przeglądarka pozwala)
  if (Pegasus.supported()) peg.reconnectKnown().catch(() => {});

  go("home");
  window.__app = { peg, trainer }; // do diagnostyki z konsoli

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
}

main();
