import { Chess } from "./lib/chess.js";
import { Pegasus } from "./pegasus.js";
import { BoardView } from "./board.js";
import { Engine, scoreText } from "./engine.js";
import { lichess, explore } from "./lichess.js";
import { t, setLang, getLang, defaultLang, translateDom, samplePgn } from "./i18n.js";
import {
  store, importPgn, inferColor, fetchLichessStudy, exportPgn, buildLine, grade, markLearned, counts,
  forecast, weakest, lineText, isUserNode, posKey, START_FEN, DAY, focusKey, subtree,
  addMove, deleteMove, deletePreview, emptyRep, validateBackup,
} from "./repertoire.js";

const VERSION = "2026-11-11 d";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const peg = new Pegasus();
const engine = new Engine();
const trainAnalysis = { open: false, eval: false, db: false, fen: null, explore: null };
const settings = () => store.data.settings;

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
    // Tryb wybrany na początku sesji pozostaje aktywny także podczas ponownego łączenia.
    return this.running ? this.usingBoard : peg.state === "on" && !!peg.occ;
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
    if (document.body.dataset.view === "train") renderTrainAnalysis();
  }

  status(main, sub = "", tone = "") {
    const el = $("#t-status");
    el.textContent = main;
    el.dataset.tone = tone;
    $("#t-sub").textContent = sub;
  }

  renderLine(steps, upto, rootFen) {
    const sans = steps.slice(0, upto).map((s) => s.san);
    $("#t-line").textContent = sans.length ? lineText(rootFen, sans) : t("(pozycja wyjściowa)");
  }

  /** Liczniki repertuaru albo — przy treningu fokusu — tylko jego wycinka. */
  counts() {
    const key = this.focus && focusKey(this.rep, this.focus);
    return counts(this.rep, Date.now(), this.focus ? subtree(this.rep, key) : null);
  }

  renderStats() {
    const s = this.stats;
    const c = this.counts();
    $("#t-progress").innerHTML =
      `<span class="pill ok">✓ ${s.ok}</span><span class="pill bad">✗ ${s.fail}</span>` +
      (s.learned ? `<span class="pill">${t("nowe")}: ${s.learned}</span>` : "") +
      `<span class="muted">${t("do powtórki")}: ${c.due}</span>`;
  }

  setComment(step) {
    const el = $("#t-comment");
    el.textContent = step && step.edge.comment ? step.edge.comment : "";
    el.hidden = !el.textContent;
  }

  // --- czekanie na planszę / ekran

  _wait(setup) {
    return new Promise((resolve, reject) => {
      const w = { reject, cleanup: [], pause: [], resume: [], pending: null };
      const done = (v) => {
        if (trainAnalysis.explore) { w.pending = { value: v }; return; }
        w.cleanup.forEach((f) => f());
        this.waiters.delete(w);
        resolve(v);
      };
      w.continue = () => {
        if (w.pending) { const value = w.pending.value; w.pending = null; done(value); }
        else w.resume.forEach((f) => f());
      };
      w.cleanup.push(() => {});
      this.waiters.add(w);
      setup(done, (f) => w.cleanup.push(f), (f) => w.pause.push(f), (f) => w.resume.push(f));
    });
  }

  abort() {
    this.running = false;
    $("#t-nav-options").hidden = true;
    for (const w of this.waiters) {
      w.cleanup.forEach((f) => f());
      w.reject(new Abort());
    }
    this.waiters.clear();
    this.board.setInteractive(null);
    this.board.setDiff(null);
    if (this.physical()) peg.leds([]);
  }

  /** Czeka na jedną z pozycji; -1 oznacza wybór przycisku „Od początku”. */
  waitOcc(targets, { showDiffFor = 0, ledDiff = false, quietIf = null, diffDelay = null, allowStart = false } = {}) {
    const sets = targets.map((c) => occOf(c));
    // pozycja „jeszcze nic nie ruszone” — wtedy nie pokazuj różnic, tylko czekaj
    const quiet = quietIf && occOf(quietIf);
    return this._wait((done, onCleanup, onPause, onResume) => {
      let diffTimer = null;
      const check = () => {
        clearTimeout(diffTimer);
        if (trainAnalysis.explore) return;
        const occ = peg.occupied();
        if (!occ) return;
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
            (missing.length ? t("Brakuje bierki na: {sq}. ", { sq: missing.join(" ") }) : "") +
            (extra.length ? t("Zbędna bierka na: {sq}.", { sq: extra.join(" ") }) : "");
        }, diffDelay ?? (ledDiff ? 1200 : 3500));
      };
      const h = () => check();
      onPause(() => clearTimeout(diffTimer));
      onResume(check);
      peg.addEventListener("occ", h);
      peg.addEventListener("state", h);
      if (allowStart) {
        const button = $("#t-from-start");
        const fromStart = () => done(-1);
        button.addEventListener("click", fromStart);
        onCleanup(() => button.removeEventListener("click", fromStart));
      }
      onCleanup(() => {
        peg.removeEventListener("occ", h);
        peg.removeEventListener("state", h);
        clearTimeout(diffTimer);
        this.board.setDiff(null);
      });
      check();
    });
  }

  /** Czeka na ruch gracza (plansza albo ekran). Zwraca obiekt ruchu chess.js (bez wykonania). */
  waitUserMove(expected) {
    if (this.physical()) {
      return this._wait((done, onCleanup, onPause, onResume) => {
        const base = occOf(this.pos);
        const touched = new Set();
        let timer = null, diffTimer = null;
        const check = (e) => {
          clearTimeout(timer);
          clearTimeout(diffTimer);
          if (trainAnalysis.explore) return;
          const occ = peg.occupied();
          if (!occ) return;
          if (e && e.detail && e.detail.square) touched.add(e.detail.square);
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
        peg.addEventListener("state", check);
        onPause(() => { clearTimeout(timer); clearTimeout(diffTimer); touched.clear(); });
        onResume(check);
        onCleanup(() => {
          peg.removeEventListener("occ", check);
          peg.removeEventListener("state", check);
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
    const side = this.rep.color === "w" ? t("czarne") : t("białe");
    this.status(
      t("Przeciwnik ({side}): {san}", { side, san: step.san }),
      this.physical()
        ? t("Przestaw bierkę przeciwnika: {from}→{to} (świeci na planszy{rot}).", { from: m.from, to: m.to, rot: peg.rotated ? t(" — kieruj się diodami, nadruki są odwrócone") : "" })
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
    this.hintFor = null;
    const m = this.verbose(step.uci);
    for (;;) {
      this.status(learn ? t("Nowy ruch: {san}", { san: step.san }) : t("Zagraj: {san}", { san: step.san }), learn ? t("Zapamiętaj go — za chwilę sprawdzian.") : t("Ten ruch znasz — tylko przypomnienie."), learn ? "new" : "");
      this.setComment(learn ? step : null);
      const shapes = (step.edge.shapes || []).filter(() => learn);
      this.show({ arrows: [{ from: m.from, to: m.to, c: "G" }, ...shapes], hl: { hint: [m.from, m.to] } });
      if (this.physical() && settings().hintLeds !== false) peg.leds(moveSquares(m));
      const got = await this.waitUserMove(step.uci);
      if (uciOf(got) === step.uci) break;
      beep("bad");
      this.status(t("To nie ten ruch ({san})", { san: got.san }), t("Cofnij go i zagraj podświetlony."), "bad");
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
        if (step.target) this.fail(step, line);
      }
      this.show({ arrows: [{ from: m.from, to: m.to, c: "R" }], hl: { hint: [m.from, m.to] } });
      if (this.physical()) peg.leds(moveSquares(m));
      this.status(t("Poprawnie: {san}", { san: step.san }), t("Zagraj ten ruch."), "bad");
    };
    this.status(t("Twój ruch ({side})", { side: this.rep.color === "w" ? t("białe") : t("czarne") }), alts.length > 1 ? t("W tej pozycji masz {n} ruchy w repertuarze.", { n: alts.length }) : "");
    this.setComment(null);
    this.show();
    for (;;) {
      const got = await this.waitUserMove(step.uci);
      const uci = uciOf(got);
      if (uci === step.uci) break;
      if (alts.includes(uci)) {
        this.status(t("{san} też jest w repertuarze", { san: got.san }), t("W tym wariancie zagraj {san}. Cofnij ruch.", { san: step.san }), "warn");
        this.show({ arrows: [{ from: m.from, to: m.to, c: "G" }], hl: { hint: [m.from, m.to] } });
        beep("move");
        await this.takeBack(got);
        if (!this.physical()) await this.sleep(900);
        if (this.physical()) peg.leds(moveSquares(m));
        this.status(t("Zagraj: {san}", { san: step.san }), t("To ruch ćwiczonego wariantu."), "warn");
        this.show({ arrows: [{ from: m.from, to: m.to, c: "G" }], hl: { hint: [m.from, m.to] } });
        continue;
      }
      beep("bad");
      if (!failed) {
        failed = true;
        if (step.target) this.fail(step, line);
      }
      const fork = alts.length > 1;
      this.show({ arrows: [{ from: got.from, to: got.to, c: "R" }, ...(fork ? [{ from: m.from, to: m.to, c: "G" }] : [])], hl: { bad: [got.from, got.to] } });
      this.status(fork ? t("Źle: {bad}. Poprawnie: {san}", { bad: got.san, san: step.san }) : t("Źle: {bad}", { bad: got.san }), this.physical() ? t("Cofnij ruch (miga na planszy).") : t("Spróbuj ponownie."), "bad");
      if (this.physical()) await this.takeBack(got);
      else await this.sleep(1300);
      if (fork) {
        if (this.physical()) peg.leds(moveSquares(m));
        this.show({ arrows: [{ from: m.from, to: m.to, c: "G" }], hl: { hint: [m.from, m.to] } });
        this.status(t("Zagraj: {san}", { san: step.san }), t("(zagrałeś {san})", { san: got.san }), "bad");
      } else {
        this.show();
        this.status(t("Twój ruch"), t("Spróbuj ponownie lub użyj Podpowiedzi."), "bad");
      }
    }
    this.hintFor = null;
    if (this.physical()) peg.leds([]);
    this.apply(m);
    if (step.target && !failed) {
      if (this.mode !== "drill") grade(step.edge, true, line); // w przeglądzie całości dobra odpowiedź nie przesuwa terminu
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

  /**
   * Ustawia planszę w pozycji po `k` ruchach nowej linii: ekran pokazuje pozycję docelową,
   * diody świecą na polach, które trzeba zmienić (na bieżąco). Przyjmuje też każdą wcześniejszą
   * pozycję tej linii (np. ustawienie od zera) — pozostałe ruchy będzie można rozegrać.
   */
  async navigate(rootFen, steps, k) {
    if (!this.physical()) return k;
    const positions = this.positionsOf(rootFen, this.played);
    const target = Math.min(this.played.length, k);
    const occ = peg.occupied();
    if (occ && setEq(occ, occOf(positions[target]))) {
      this.played = this.played.slice(0, target);
      this.synced = true;
      return target;
    }
    this.pos = new Chess(positions[target].fen());
    this.lastMove = null;
    this.show();
    this.status(
      t("Ustaw pozycję jak na ekranie"),
      target ? t("Świecą pola do zmiany — czerwona ramka: zdejmij, niebieska: postaw. Możesz nacisnąć „Od początku”.")
        : t("Ustaw pozycję początkową — czerwona ramka: zdejmij, niebieska: postaw."),
      "warn"
    );
    $("#t-nav-options").hidden = target === 0;
    let idx;
    try {
      idx = await this.waitOcc(positions.slice(0, target + 1), { showDiffFor: target, ledDiff: true, diffDelay: 250, allowStart: target > 0 });
    } finally {
      $("#t-nav-options").hidden = true;
    }
    peg.leds([]);
    if (idx === -1) return this.navigate(rootFen, steps, 0);
    this.synced = true;
    this.played = this.played.slice(0, idx);
    return idx;
  }

  async playLine(line, phase) {
    const rootFen = this.rep.nodes[line.root].fen;
    if (this.root !== line.root) {
      this.root = line.root;
      this.played = [];
      this.synced = false;
    }
    const steps = line.steps;
    const failsBefore = this.stats.fail;
    let k = 0;
    while (k < this.played.length && k < steps.length && this.played[k] === steps[k].uci) k++;
    k = Math.min(k, steps.findIndex((s) => s.target)); // wróć co najmniej przed pierwszy cel
    $("#t-line").textContent = "";
    if (this.physical()) k = await this.navigate(rootFen, steps, k);
    this.pos = this.positionsOf(rootFen, steps.slice(0, k).map((s) => s.uci))[k];
    this.lastMove = null;
    this.show();
    const sans = steps.map((s) => s.san);
    for (let i = k; i < steps.length; i++) {
      if (!this.running) throw new Abort();
      const step = steps[i];
      this.renderLine(steps, i, rootFen);
      const line = lineText(rootFen, sans.slice(0, i + 1));
      $("#t-hint").hidden = !step.user || (step.target && phase === "show");
      if (!step.user) await this.opponentMove(step);
      else if (step.target && phase === "show") {
        await this.showMove(step, true);
        markLearned(step.edge, line);
        store.logReview(this.rep, true, true);
        this.stats.learned++;
        this.renderStats();
      } else await this.quizMove(step, line);
      this.played = steps.slice(0, i + 1).map((s) => s.uci);
      this.renderLine(steps, i + 1, rootFen);
    }
    store.save();
    const failed = this.stats.fail > failsBefore;
    const pause = settings().pauseAfterLine || "error";
    if (trainAnalysis.open || (phase === "quiz" && (pause === "always" || (pause === "error" && failed)))) await this.pauseAfterLine(failed);
    else await this.sleep(phase === "show" ? 400 : 700);
  }

  /** Zatrzymanie na końcu linii — czas na analizę; dalej po przycisku „Dalej”. */
  pauseAfterLine(failed) {
    this.hintFor = null;
    $("#t-hint").hidden = true;
    this.status(
      failed ? t("Linia z błędem") : t("Koniec linii"),
      (failed ? t("„Analiza” → „Wypróbuj ruchy”, a „← Cofnij ruch” wraca do miejsca błędu. ") : t("Możesz przeanalizować pozycję. ")) + t("Potem naciśnij „Dalej”."),
      failed ? "warn" : ""
    );
    return this._wait((done, onCleanup) => {
      const btn = $("#t-next");
      const next = () => done();
      btn.hidden = false;
      btn.addEventListener("click", next);
      onCleanup(() => { btn.removeEventListener("click", next); btn.hidden = true; });
    });
  }

  async run(rep, mode, focus = null) {
    this.rep = rep;
    this.mode = mode;
    this.focus = focus;
    this.usingBoard = peg.state === "on" && !!peg.occ;
    this.running = true;
    this.stats = { ok: 0, fail: 0, learned: 0 };
    this.retry = new Set();
    // przy fokusie pierwsza linia może zacząć się od jego pozycji (albo od początku — na planszy do wyboru)
    this.root = focus ? focus.root : null;
    this.played = focus ? [...focus.path] : [];
    this.synced = false;
    this.lastMove = null;
    this.board.setOrientation(rep.color);
    $("#t-title").textContent = `${rep.name}${focus ? ` › ${focus.name}` : ""} — ${t({ learn: "nowe ruchy", review: "powtórki", drill: "przegląd całości" }[mode])}`;
    $("#t-hint").hidden = true;
    $("#t-nav-options").hidden = true;
    this.hintFor = null;
    this.renderStats();
    let wake = null;
    let pausedStatus = null;
    const onConnection = () => {
      if (!this.usingBoard) return;
      if (peg.state === "lost" || peg.state === "connecting" || peg.state === "off") {
        if (!pausedStatus) pausedStatus = [$("#t-status").textContent, $("#t-sub").textContent, $("#t-status").dataset.tone];
        this.status(
          peg.state === "off" ? t("Plansza rozłączona") : t("Łączę ponownie z planszą…"),
          peg.state === "off" ? t("Połącz ją ponownie albo zakończ trening.") : t("Trening wznowi się po odczytaniu pozycji."),
          "warn"
        );
        this.board.setDiff(null);
      } else if (peg.state === "on" && pausedStatus) {
        this.status(...pausedStatus);
        pausedStatus = null;
      }
    };
    if (this.usingBoard) peg.addEventListener("state", onConnection);
    try {
      wake = await navigator.wakeLock?.request("screen");
    } catch {}
    let newLeft = Number(settings().newPerSession) || 10;
    let retryRound = false;
    const drilled = new Set();
    try {
      if (!this.running) throw new Abort();
      if (trainAnalysis.explore) await this._wait((done, cleanup, pause, resume) => resume(() => done()));
      for (;;) {
        let line;
        if (mode === "learn") {
          line = buildLine(rep, "learn", { prefer: this.played, preferRoot: this.root, limit: newLeft, focus });
          if (!line) break;
          const n = line.steps.filter((s) => s.target).length;
          await this.playLine(line, "show");
          newLeft -= n;
          // od razu sprawdzian tej samej linii
          this.status(t("Sprawdzian"), t("Teraz bez podpowiedzi."), "new");
          await this.sleep(900);
          const quiz = { root: line.root, steps: line.steps.map((s) => ({ ...s })) };
          await this.playLine(quiz, "quiz");
          if (newLeft <= 0) break;
        } else {
          line = buildLine(rep, mode, {
            prefer: this.played, preferRoot: this.root, focus,
            exclude: mode === "drill" ? drilled : retryRound ? new Set() : this.retry,
            now: Date.now() + (retryRound ? 5 * 60 * 1000 : 0),
          });
          if (!line) {
            if (!retryRound && this.retry.size) {
              retryRound = true;
              if (mode === "drill") for (const k of this.retry) drilled.delete(k);
              this.retry.clear();
              this.status(t("Poprawka błędów"), t("Jeszcze raz ruchy, które się nie udały."), "warn");
              await this.sleep(1200);
              continue;
            }
            break;
          }
          await this.playLine(line, "quiz");
          if (mode === "drill") for (const st of line.steps) if (st.target) drilled.add(st.fen + st.uci);
        }
      }
      this.finish();
    } catch (e) {
      if (!(e instanceof Abort)) {
        console.error(e);
        this.status(t("Błąd"), String(e.message || e), "bad");
      }
    } finally {
      peg.removeEventListener("state", onConnection);
      this.running = false;
      store.save();
      try { wake && wake.release(); } catch {}
      if (this.physical()) peg.leds([]);
    }
  }

  finish() {
    const s = this.stats;
    const c = this.counts();
    beep("done");
    this.board.setArrows([]);
    $("#t-nav-options").hidden = true;
    this.hintFor = null;
    $("#t-hint").hidden = true;
    if (this.mode === "drill")
      this.status(s.ok + s.fail ? t("Przegląd zrobiony 🎉") : t("Nic do przeglądu"), s.ok + s.fail ? `✓ ${s.ok}  ✗ ${s.fail}  (${Math.round((100 * s.ok) / (s.ok + s.fail))}%). ` + t("Błędne ruchy wróciły do powtórek.") : t("Najpierw poznaj nowe ruchy ({n}).", { n: c.fresh }), "good");
    else if (this.mode === "learn")
      this.status(s.learned ? t("Poznane nowe ruchy: {n}", { n: s.learned }) : t("Brak nowych ruchów"), t("Sprawdzian: ✓ {ok}  ✗ {fail}. Nowych zostało: {n}.", { ok: s.ok, fail: s.fail, n: c.fresh }), "good");
    else
      this.status(s.ok + s.fail ? t("Powtórki zrobione 🎉") : t("Nic do powtórki"), s.ok + s.fail ? `✓ ${s.ok}  ✗ ${s.fail}  (${Math.round((100 * s.ok) / (s.ok + s.fail))}%)` : t("Następne powtórki: {when}. Możesz poznać nowe ruchy ({n}).", { when: nextDueText(this.rep, this.focus && subtree(this.rep, focusKey(this.rep, this.focus))), n: c.fresh }), "good");
    this.renderStats();
    $("#t-stop").hidden = true;
    $("#t-back-rep").hidden = false;
    if (this.physical()) peg.leds([]);
  }
}

function nextDueText(rep, keys = null) {
  let min = Infinity;
  for (const [key, node] of Object.entries(rep.nodes))
    if ((!keys || keys.has(key)) && isUserNode(rep, node))
      for (const e of Object.values(node.moves)) if (e.srs && e.srs.due < min) min = e.srs.due;
  if (min === Infinity) return "brak";
  return whenText(min);
}

function whenText(time) {
  const d = time - Date.now();
  if (d <= 0) return t("teraz");
  if (d < 3600e3) return t("za {n} min", { n: Math.max(1, Math.round(d / 60e3)) });
  if (d < DAY) return t("za {n} h", { n: Math.round(d / 3600e3) });
  const days = Math.round(d / DAY);
  return days === 1 ? t("jutro") : t("za {n} dni", { n: days });
}

// ---------------------------------------------------------------- widoki

let trainBoard, analysisBoard, browseBoard, trainer;

function go(view) {
  const previous = document.body.dataset.view;
  if (previous !== view && (previous === "train" || previous === "browse")) {
    if (previous === "train") discardTrainExplore();
    engine.job++;
    engine.stopLocal();
    dbRequest++;
  }
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
            <h3 data-no-i18n>${esc(r.name)}</h3>
            <span class="muted">${r.color === "w" ? t("białe") : t("czarne")} · ${t("{n} ruchów", { n: c.total })}</span>
          </div>
          <div class="bar"><span style="width:${pct}%"></span></div>
          <div class="muted small">${t("poznane {learned}/{total} · nowe {fresh} · następne powtórki: {when}", { ...c, when: c.due ? t("teraz") : nextDueText(r) })}</div>
          <div class="row">
            <button class="primary" data-act="review" ${c.due ? "" : "disabled"}>Powtórki <b>${c.due}</b></button>
            <button class="accent" data-act="learn" ${c.fresh ? "" : "disabled"}>Nowe ruchy <b>${Math.min(c.fresh, Number(settings().newPerSession) || 10)}</b></button>
            <button data-act="browse">Edytuj</button>
            <button data-act="more" class="ghost" aria-label="Więcej">⋯</button>
          </div>
          ${(r.focus || []).map((f) => focusHtml(r, f)).join("")}
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
    ? totalDue ? t("Do powtórki dzisiaj: {n}", { n: totalDue }) : t("Wszystkie powtórki zrobione.")
    : "";
}

/** Fokus: wycinek repertuaru od wybranej pozycji (te same ruchy i postępy). */
function focusHtml(rep, f) {
  const key = focusKey(rep, f);
  const line = lineText(rep.nodes[f.root]?.fen || START_FEN, f.sans || []);
  const head = `<div class="focus-head"><b data-no-i18n>🎯 ${esc(f.name)}</b>${f.name !== line ? `<span class="muted small">${esc(line)}</span>` : ""}` +
    `<button class="ghost focus-del" data-act="focus-del" aria-label="Usuń fokus" title="Usuń fokus (ruchy i postępy zostają)">✕</button></div>`;
  if (!key)
    return `<div class="focus" data-focus="${esc(f.id)}">${head}
      <p class="muted small">Tej pozycji nie ma już w repertuarze — usuń fokus albo dodaj ruchy z powrotem.</p></div>`;
  const keys = subtree(rep, key);
  const c = counts(rep, Date.now(), keys);
  return `<div class="focus" data-focus="${esc(f.id)}">${head}
    <div class="muted small">${t("poznane {learned}/{total} · nowe {fresh} · następne powtórki: {when}", { ...c, when: c.due ? t("teraz") : nextDueText(rep, keys) })}</div>
    <div class="row">
      <button class="primary" data-act="review" ${c.due ? "" : "disabled"}>Powtórki <b>${c.due}</b></button>
      <button class="accent" data-act="learn" ${c.fresh ? "" : "disabled"}>Nowe <b>${Math.min(c.fresh, Number(settings().newPerSession) || 10)}</b></button>
      <button data-act="drill" ${c.learned ? "" : "disabled"} title="Wszystkie poznane ruchy tego fragmentu, bez względu na termin powtórki">Przećwicz całość <b>${c.learned}</b></button>
    </div></div>`;
}

async function onHomeClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const card = btn.closest(".rep");
  const rep = card && store.rep(card.dataset.id);
  const act = btn.dataset.act;
  if (act === "import") return openImport(null);
  if (act === "sample") {
    const r = store.newRep(t("Przykład: włoska"), "w");
    importPgn(r, samplePgn());
    await store.saveNow();
    return renderHome();
  }
  if (!rep) return;
  const focusEl = btn.closest(".focus");
  const focus = focusEl && (rep.focus || []).find((f) => f.id === focusEl.dataset.focus);
  if (focusEl) {
    if (!focus) return;
    if (act === "focus-del") {
      rep.focus = rep.focus.filter((f) => f !== focus);
      store.save();
      return renderHome();
    }
    if (act === "review" || act === "learn" || act === "drill") return startTraining(rep, act, focus);
    return;
  }
  if (act === "review" || act === "learn") return startTraining(rep, act);
  if (act === "browse") return openBrowse(rep);
  if (act === "more") return (card.querySelector(".more-menu").hidden ^= true);
  if (act === "add") return openImport(rep);
  if (act === "export") return download(`${rep.name}.pgn`, exportPgn(rep), "application/x-chess-pgn");
  if (act === "rename") {
    const n = prompt(t("Nowa nazwa:"), rep.name);
    if (n) { rep.name = n.trim(); store.save(); renderHome(); }
    return;
  }
  if (act === "reset") {
    if (!confirm(t("Wyzerować postępy w „{name}”? Ruchy zostaną, ale wszystkie będą znów nowe.", { name: rep.name }))) return;
    for (const n of Object.values(rep.nodes)) for (const ed of Object.values(n.moves)) delete ed.srs;
    store.save();
    return renderHome();
  }
  if (act === "delete") {
    if (!confirm(t("Usunąć repertuar „{name}”? Tego nie da się cofnąć (chyba że masz kopię zapasową).", { name: rep.name }))) return;
    store.deleteRep(rep.id);
    renderHome();
  }
}

/** Pyta o figurę promocji; przyjmuje litery polskie (h w g s) i angielskie (q r b n). */
function askPromotion() {
  const p = (prompt(t("Promocja na: h (hetman), w (wieża), g (goniec), s (skoczek)"), getLang() === "en" ? "q" : "h") || "q").toLowerCase()[0];
  return { h: "q", w: "r", g: "b", s: "n", q: "q", r: "r", b: "b", n: "n" }[p] || "q";
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
  $("#imp-title").textContent = rep ? t("Dodaj do: {name}", { name: rep.name }) : t("Nowy repertuar");
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
      if (!f) throw new Error(t("Wybierz plik PGN."));
      text = await f.text();
    } else text = $("#imp-text").value;
    if (!text || !text.trim()) throw new Error(t("Pusty PGN."));

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
      if (!name) name = (text.match(/\[StudyName\s+"([^"]+)"\]/) || text.match(/\[Event\s+"([^"]+)"\]/) || [])[1] || t("Mój repertuar");
      rep = store.newRep(name, color);
      guessed = guess;
    }
    const res = importPgn(rep, text);
    await store.saveNow();
    const c = counts(rep);
    out.innerHTML = `<div class="card ok-card">
      ${t("<b>Gotowe.</b> Wczytano {games} {what}, nowych ruchów: {added}.", { games: res.games, what: res.games === 1 ? t("partię/rozdział") : t("partii/rozdziałów"), added: res.added })}
      ${t("Twoich ruchów do nauki w repertuarze „{name}” ({color}): {total}.", { name: esc(rep.name), color: rep.color === "w" ? t("białe") : t("czarne"), total: c.total })}
      ${guessed ? `<p class="small">Kolor rozpoznany po kształcie drzewa wariantów — jeśli się nie zgadza, usuń repertuar i zaimportuj z wybranym kolorem.</p>` : ""}
      ${res.errors.length ? `<details><summary>${t("Pominięte fragmenty ({n})", { n: res.errors.length })}</summary><ul>${res.errors.slice(0, 30).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
      <div class="row"><button class="primary" data-go="home">Do repertuarów</button></div></div>`;
    if (!importTarget) {
      $("#imp-name").value = "";
      importTarget = rep;
      $("#imp-new").hidden = true;
      $("#imp-title").textContent = t("Dodaj do: {name}", { name: rep.name });
    }
  } catch (e) {
    out.innerHTML = `<div class="card bad-card">${esc(e.message || e)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// --- trening

function startTraining(rep, mode, focus = null) {
  trainAnalysis.open = false;
  trainAnalysis.eval = false;
  trainAnalysis.db = false;
  trainer.rep = rep;
  trainer.pos = new Chess(rep.nodes[rep.roots[0]]?.fen || START_FEN);
  trainBoard.setPosition(trainer.pos.fen());
  trainAnalysis.fen = null;
  go("train");
  renderTrainAnalysis(true);
  $("#t-stop").textContent = t("Zakończ");
  $("#t-stop").hidden = false;
  $("#t-back-rep").hidden = true;
  $("#t-comment").hidden = true;
  $("#t-line").textContent = "";
  if (!peg.occ || peg.state !== "on")
    $("#t-mode").textContent = t("Bez planszy — ruchy na ekranie (dotknij bierkę, potem pole).");
  else $("#t-mode").textContent = t("Plansza: {name}", { name: peg.device?.name || "Pegasus" });
  trainer.run(rep, mode, focus);
}

function renderTrainAnalysis(force = false) {
  const state = trainAnalysis;
  $("#view-train").classList.toggle("analysis-open", state.open);
  $("#t-analysis").hidden = !state.open;
  $("#t-analysis-toggle").setAttribute("aria-expanded", String(state.open));
  $("#t-analysis-toggle").textContent = state.open ? t("Zamknij analizę") : t("Analiza");
  $("#t-eval-toggle").setAttribute("aria-pressed", String(state.eval));
  $("#t-db-toggle").setAttribute("aria-pressed", String(state.db));
  $("#t-eval").hidden = !state.eval;
  $("#t-db").hidden = !state.db;
  $("#t-analysis-empty").hidden = state.eval || state.db;
  if (!state.open) {
    engine.job++;
    engine.stopLocal();
    dbRequest++;
    return;
  }
  const fen = (state.explore?.chess || trainer.pos)?.fen();
  if (!fen) {
    $("#t-eval").textContent = t("Czekam na pozycję…");
    $("#t-db-body").textContent = t("Czekam na pozycję…");
    return;
  }
  if (!force && state.fen === fen) return;
  state.fen = fen;
  const node = trainer.rep?.nodes[posKey(fen)] || { moves: {} };
  const current = () => document.body.dataset.view === "train" && state.open && state.fen === fen;
  if (state.eval) renderEvaluation(fen, node, $("#t-eval"), current, !!state.explore && !state.explore.restoring);
  else { engine.job++; engine.stopLocal(); }
  if (state.db) {
    const src = settings().dbSrc || "lichess";
    $$("input[name=tdbsrc]").forEach((r) => (r.checked = r.value === src));
    renderDatabase(fen, node, src, $("#t-db-body"), $("#t-db-opening"), current, !!state.explore && !state.explore.restoring, false);
  } else dbRequest++;
}

// Próbna linia ma własną pozycję i nie zmienia stanu powtórki.
function startTrainExplore() {
  if (!trainer.pos || trainAnalysis.explore) return;
  const physical = trainer.running ? trainer.usingBoard : peg.state === "on" && !!peg.occ;
  const root = trainer.pos.fen();
  // z historią bieżącej linii — „Cofnij ruch” może wrócić przed pozycję treningową (np. do błędu)
  const fresh = () => {
    const start = trainer.root && trainer.rep?.nodes[trainer.root]?.fen;
    if (start && trainer.played?.length) {
      const c = new Chess(start);
      try {
        for (const u of trainer.played) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        if (c.fen() === root) return { chess: c, start };
      } catch {}
    }
    return { chess: new Chess(root), start: root };
  };
  const { chess, start } = fresh();
  trainAnalysis.explore = { chess, root, start, fresh: () => fresh().chess, physical, synced: false, restoring: false, touched: new Set(), timer: null, closeOnReturn: false };
  for (const waiter of trainer.waiters) waiter.pause.forEach((f) => f());
  $("#t-board").hidden = true;
  $("#t-analysis-board").hidden = false;
  $("#t-explore").hidden = true;
  $("#t-explore-back").hidden = false;
  $("#t-explore-reset").hidden = false;
  $("#t-explore-return").hidden = false;
  $("#t-explore-info").hidden = false;
  $("#t-hint").disabled = true;
  $("#t-from-start").disabled = true;
  $("#t-next").disabled = true;
  analysisBoard.setOrientation(trainBoard.orientation);
  if (physical && peg.state === "on") peg.leds([]);
  drawTrainExplore();
  onTrainExploreOcc();
}

function drawTrainExplore() {
  const e = trainAnalysis.explore;
  if (!e) return;
  const history = e.chess.history({ verbose: true });
  const last = history[history.length - 1];
  analysisBoard.setPosition(e.chess.fen());
  analysisBoard.setHighlights({ last: last ? [last.from, last.to] : null });
  analysisBoard.setArrows([]);
  const legal = e.chess.moves({ verbose: true });
  analysisBoard.setInteractive(e.restoring ? null : (sq) => legal.filter((m) => m.from === sq).map((m) => m.to));
  analysisBoard.onMove = (from, to) => {
    const options = legal.filter((m) => m.from === from && m.to === to);
    if (!options.length) return;
    let move = options[0];
    if (options.length > 1) {
      const p = askPromotion();
      move = options.find((m) => m.promotion === p) || move;
    }
    playTrainExplore(move);
  };
  $("#t-explore-back").disabled = e.restoring || !history.length;
  $("#t-explore-reset").disabled = e.restoring || e.chess.fen() === e.root;
  $("#t-explore-return").disabled = e.restoring;
  const line = history.length ? lineText(e.start, history.map((m) => m.san)) : t("pozycja treningowa");
  $("#t-explore-info").textContent = e.restoring
    ? t("Ustaw na Pegasusie pozycję pokazaną na ekranie, aby wrócić do treningu.")
    : t("Próbna linia: {line}. Trening jest wstrzymany.", { line }) +
      (e.physical && !e.synced ? t(" Ustaw na Pegasusie pozycję z ekranu, aby grać na planszy.") : "");
  renderTrainAnalysis(true);
}

function playTrainExplore(move) {
  const e = trainAnalysis.explore;
  if (!e || e.restoring) return;
  clearTimeout(e.timer);
  e.chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  e.touched.clear();
  e.synced = !e.physical || (peg.state === "on" && !!peg.occupied() && setEq(peg.occupied(), occOf(e.chess)));
  drawTrainExplore();
  onTrainExploreOcc();
}

function onTrainExploreOcc(event) {
  const e = trainAnalysis.explore;
  if (!e || !e.physical || document.body.dataset.view !== "train") return;
  clearTimeout(e.timer);
  const occ = peg.state === "on" ? peg.occupied() : null;
  if (!occ) {
    e.synced = false;
    $("#t-explore-info").textContent = t("Połącz planszę Pegasus, aby zsynchronizować pozycję.");
    return;
  }
  const want = occOf(e.chess);
  if (setEq(occ, want)) {
    e.touched.clear();
    analysisBoard.setDiff(null);
    if (e.restoring) return finishTrainExplore();
    if (!e.synced) { e.synced = true; drawTrainExplore(); }
    return;
  }
  if (e.restoring || !e.synced) {
    const missing = [...want].filter((sq) => !occ.has(sq));
    const extra = [...occ].filter((sq) => !want.has(sq));
    analysisBoard.setDiff({ missing, extra });
    if (e.restoring) peg.leds([...missing, ...extra]);
    return;
  }
  if (event?.detail?.square) e.touched.add(event.detail.square);
  const candidates = matchMoves(e.chess, occ, e.touched);
  if (candidates.length) e.timer = setTimeout(() => {
    if (trainAnalysis.explore === e && !e.restoring) playTrainExplore(candidates[0]);
  }, 1300);
}

function returnFromTrainExplore(closePanel = false) {
  const e = trainAnalysis.explore;
  if (!e) return;
  e.closeOnReturn ||= closePanel;
  e.restoring = true;
  clearTimeout(e.timer);
  e.chess = new Chess(e.root);
  drawTrainExplore();
  if (!e.physical) return finishTrainExplore();
  onTrainExploreOcc();
}

function discardTrainExplore() {
  const e = trainAnalysis.explore;
  if (!e) return;
  clearTimeout(e.timer);
  trainAnalysis.explore = null;
  analysisBoard.setInteractive(null);
  analysisBoard.onMove = null;
  analysisBoard.setDiff(null);
  $("#t-board").hidden = false;
  $("#t-analysis-board").hidden = true;
  $("#t-explore").hidden = false;
  $("#t-explore-back").hidden = true;
  $("#t-explore-reset").hidden = true;
  $("#t-explore-return").hidden = true;
  $("#t-explore-info").hidden = true;
  $("#t-hint").disabled = false;
  $("#t-from-start").disabled = false;
  $("#t-next").disabled = false;
  if (e.physical && peg.state === "on") peg.leds([]);
}

function finishTrainExplore() {
  const closePanel = trainAnalysis.explore?.closeOnReturn;
  discardTrainExplore();
  if (closePanel) trainAnalysis.open = false;
  renderTrainAnalysis(true);
  if (trainer.running && trainer.usingBoard && peg.state === "on") {
    const squares = trainer.board.arrows.flatMap((a) => a.from && a.to ? [a.from, a.to] : []);
    if (squares.length) peg.leds(squares);
  }
  for (const waiter of [...trainer.waiters]) waiter.continue();
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
    toast(userBefore.length ? t("Dodano {san} — w tej pozycji masz teraz też: {other}", { san: mv.san, other: userBefore.join(", ") }) : t("Dodano ruch {san}", { san: mv.san }));
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
      const p = askPromotion();
      m = ms.find((x) => x.promotion === p) || ms[0];
    }
    browsePlay(m);
  };

  $("#b-title").textContent = rep.name;
  $("#b-focus").hidden = !browse.path.length;
  $("#b-line").textContent = sans.length ? lineText(rootFen, sans) : t("(pozycja wyjściowa)");
  $("#b-roots").hidden = rep.roots.length < 2;
  $("#b-roots").innerHTML = rep.roots.map((r, i) => `<option value="${esc(r)}" ${r === browse.root ? "selected" : ""}>${t("Pozycja startowa {n}", { n: i + 1 })}${r === posKey(START_FEN) ? t(" (zwykła)") : ""}</option>`).join("");

  const cbox = $("#b-comment-box");
  cbox.hidden = !lastEdge;
  if (lastEdge) {
    $("#b-comment-label").textContent = t("Komentarz do ruchu {san}", { san: sans[sans.length - 1] });
    const ta = $("#b-comment");
    if (document.activeElement !== ta) ta.value = lastEdge.comment || "";
  }

  $("#b-moves").innerHTML =
    `<p class="muted small">${user ? t("Twoje ruchy") : t("Ruchy przeciwnika")} — ${edges.length ? t("stuknij, żeby przejść") : t("brak")}. ${t("Nowy ruch dodasz, wykonując go na szachownicy")}${peg.state === "on" ? t(" (ekran albo Pegasus)") : ""}.</p>` +
    edges
      .map(([u, e]) => {
        let st = "";
        if (user) st = !e.srs ? `<span class="pill">nowy</span>` : e.srs.due <= Date.now() ? `<span class="pill bad">${t("do powtórki")}</span>` : `<span class="pill ok">${whenText(e.srs.due)}</span>`;
        return `<div class="move-row"><button class="move-btn" data-uci="${u}"><b>${esc(e.san)}</b> ${st}${e.srs && e.srs.lapses ? `<span class="muted small">${t("błędy: {n}", { n: e.srs.lapses })}</span>` : ""}${e.comment ? `<span class="muted small" title="${esc(e.comment)}">💬</span>` : ""}</button><button class="ghost del" data-del="${u}" aria-label="${t("Usuń {san}", { san: esc(e.san) })}" title="${t("Usuń ruch i dalsze")}">🗑</button></div>`;
      })
      .join("");
  syncBrowsePhysical();
  renderEval(chess, node);
  renderDb(chess, node);
}

// --- baza partii Lichess w edytorze

const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + t(" mln") : n >= 1e4 ? Math.round(n / 1e3) + t(" tys.") : String(n));

let dbRequest = 0;
async function renderDb(chess, node) {
  const on = !!settings().dbOn;
  $("#b-db-toggle").setAttribute("aria-pressed", String(on));
  const box = $("#b-db");
  box.hidden = !on;
  if (!on) { dbRequest++; return; }
  const src = settings().dbSrc || "lichess";
  $$("input[name=dbsrc]").forEach((r) => (r.checked = r.value === src));
  const fen = chess.fen();
  renderDatabase(fen, node, src, $("#b-db-body"), $("#b-db-opening"),
    () => document.body.dataset.view === "browse" && fen === browse.chess?.fen(), true);
}

async function renderDatabase(fen, node, src, body, opening, isCurrent, interactive, allowSettings = interactive) {
  const request = ++dbRequest;
  body.innerHTML = `<p class="muted small">Wczytuję…</p>`;
  opening.textContent = "";
  try {
    const d = await explore(fen, src, { ratings: settings().liRatings, speeds: settings().liSpeeds });
    if (request !== dbRequest || !isCurrent()) return;
    opening.textContent = d.opening ? `${d.opening.eco} ${d.opening.name}` : "";
    if (!d.moves.length) {
      body.innerHTML = `<p class="muted small">${t("Brak partii z tej pozycji w bazie {db}.", { db: src === "masters" ? t("mistrzów") : "Lichess" })}</p>`;
      return;
    }
    const inRep = new Set(Object.values(node.moves).map((e) => e.san));
    const pct = (a, n) => (n ? Math.round((100 * a) / n) : 0);
    const row = (m) => {
      const w = pct(m.white, m.games), dr = pct(m.draws, m.games), b = 100 - w - dr;
      return `<tr${interactive ? ` data-san="${esc(m.san)}"` : ""}><td class="san">${esc(m.san)} ${inRep.has(m.san) ? `<span class="pill ok" title="w repertuarze">✓</span>` : ""}</td>
        <td class="num">${pct(m.games, d.total)}%</td><td class="num muted">${fmtN(m.games)}</td>
        <td><div class="wdl" title="${t("białe {w}% · remis {d}% · czarne {b}%", { w, d: dr, b })}"><span class="w" style="width:${w}%">${w > 12 ? w + "%" : ""}</span><span class="d" style="width:${dr}%">${dr > 12 ? dr + "%" : ""}</span><span class="b" style="width:${b}%">${b > 12 ? b + "%" : ""}</span></div></td></tr>`;
    };
    body.innerHTML = `<table class="db-table">${d.moves.map(row).join("")}<tr class="db-total"><td>razem</td><td></td><td class="num">${fmtN(d.total)}</td><td></td></tr></table>`;
  } catch (e) {
    if (request !== dbRequest || !isCurrent()) return;
    body.innerHTML = `<p class="small">${esc(e.message)}${e.code === "auth" && allowSettings ? ` <button class="ghost" data-go="settings">Ustawienia</button>` : ""}</p>`;
  }
}

function renderLichess() {
  const u = lichess.user();
  $("#li-status").innerHTML = u ? t("Zalogowany jako <b>{user}</b> ✓", { user: esc(u) }) : `<span class="muted">${t("Niezalogowany — baza partii wymaga konta Lichess (darmowe).")}</span>`;
  $("#li-login").hidden = !!u;
  $("#li-logout").hidden = !u;
  $("#li-ratings").value = settings().liRatings || "1800,2000,2200,2500";
  $("#li-speeds").value = settings().liSpeeds || "blitz,rapid,classical";
}

// --- ocena silnika w edytorze i treningu

function renderEval(chess, node) {
  const on = !!settings().evalOn;
  $("#b-eval-toggle").setAttribute("aria-pressed", String(on));
  const box = $("#b-eval");
  box.hidden = !on;
  if (!on) {
    engine.job++;
    engine.stopLocal();
    return;
  }
  const fen = chess.fen();
  renderEvaluation(fen, node, box,
    () => document.body.dataset.view === "browse" && fen === browse.chess?.fen(), true);
}

function renderEvaluation(fen, node, box, isCurrent, interactive) {
  const chess = new Chess(fen);
  if (chess.isGameOver()) {
    box.innerHTML = `<span class="eval-src">${chess.isCheckmate() ? "Mat." : "Koniec partii."}</span>`;
    return;
  }
  box.innerHTML = `<span class="eval-src">Liczę…</span>`;
  engine.analyse(fen, (res) => {
    if (!isCurrent()) return;
    const inRep = new Set(Object.keys(node.moves));
    const lines = res.lines.map((l) => {
      const c = new Chess(fen);
      const sans = [];
      for (const u of l.pv.slice(0, 8)) {
        try { sans.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); } catch { break; }
      }
      if (!sans.length) return "";
      const first = l.pv[0];
      const txt = lineText(fen, sans).replace(/^(\d+\.(?:\.\.)? )?(\S+)/, (m0, num = "", mv) => `${num}<b>${esc(mv)}</b>`);
      const tag = interactive ? "button" : "div";
      return `<${tag} class="eval-line"${interactive ? ` data-ev="${first}"` : ""}><span class="eval-score">${scoreText(l)}</span><span class="eval-pv">${txt}</span>${inRep.has(first) ? `<span class="pill ok" title="ruch jest w repertuarze">✓</span>` : ""}</${tag}>`;
    });
    box.innerHTML =
      `<span class="eval-src">${esc(t(res.source))}${res.depth ? t(", głębokość {n}", { n: res.depth }) : ""}${res.pending ? t(" — liczę…") : ""}</span>` +
      (lines.join("") || "");
  });
}

function browseDelete(uci) {
  const rep = browse.rep;
  const { key } = browseState();
  const e = rep.nodes[key].moves[uci];
  const p = deletePreview(rep, key, uci);
  const n = p.moves - 1;
  const word = t(n === 1 ? "dalszy ruch" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "dalsze ruchy" : "dalszych ruchów");
  const more = n > 0 ? t(" i {n} {word} (Twoich: {user}{learned})", { n, word, user: p.userMoves, learned: p.learned ? t(", w tym poznanych: {n}", { n: p.learned }) : "" }) : "";
  if (!confirm(t("Usunąć {san}{more}?\n\nPozycje osiągalne inną kolejnością ruchów zostaną.", { san: e.san, more }))) return;
  deleteMove(rep, key, uci);
  toast(t("Usunięto {san}", { san: e.san }));
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
  sel.innerHTML = `<option value="">Wszystkie</option>` + reps.map((r) => `<option value="${r.id}" data-no-i18n>${esc(r.name)}</option>`).join("");
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
  ].map(([k, v]) => `<div class="tile"><div class="tile-v">${v}</div><div class="tile-k">${t(k)}</div></div>`).join("");

  const dn = (d) => d.toLocaleDateString(getLang() === "en" ? "en-GB" : "pl-PL", { weekday: "short" });
  const maxF = Math.max(1, ...fc);
  $("#s-forecast").innerHTML = fc
    .map((v, i) => {
      const d = new Date(today0 + i * DAY);
      return `<div class="col" title="${v}"><span class="v">${v || ""}</span><div class="b" style="height:${(100 * v) / maxF}%"></div><span class="k">${i === 0 ? t("dziś") : i === 1 ? t("jutro") : dn(d) + " " + d.getDate()}</span></div>`;
    })
    .join("");

  const maxH = Math.max(1, ...days.map((d) => d.ok + d.bad));
  $("#s-history").innerHTML = days
    .map((d) => `<div class="col" title="✓ ${d.ok}  ✗ ${d.bad}"><span class="v">${d.ok + d.bad || ""}</span>
      <div class="stack" style="height:${(100 * (d.ok + d.bad)) / maxH}%"><div class="b bad" style="flex:${d.bad}"></div><div class="b" style="flex:${d.ok}"></div></div>
      <span class="k">${dn(d.d)} ${d.d.getDate()}</span></div>`)
    .join("");

  $("#s-weak").innerHTML = weak.length
    ? weak.map((w) => `<li>${t("{san} — błędy: {n}, następna powtórka {when}", { san: `<b>${esc(w.san)}</b>`, n: w.srs.lapses, when: whenText(w.srs.due) })}<div class="muted small">${esc(w.srs.line || "")}${chosen.length > 1 ? " · " + esc(w.rep.name) : ""}</div></li>`).join("")
    : `<li class="muted">Brak błędów — albo jeszcze nic nie powtarzałeś.</li>`;
}

// --- ustawienia

function renderSettings() {
  const s = settings();
  renderLichess();
  $("#set-version").textContent = t("Wersja aplikacji: {v}", { v: VERSION });
  $("#set-new").value = s.newPerSession || 10;
  $("#set-pause").value = s.pauseAfterLine || "error";
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
  const pct = peg.battery?.pct;
  const hasBattery = Number.isFinite(pct);
  const name = peg.device?.name || "DGT Pegasus";
  const label = st === "on"
    ? (hasBattery ? `${Math.max(0, Math.min(100, Math.round(pct)))}%${peg.battery.charging ? "⚡" : ""}` : "…")
    : st === "connecting" ? "…"
    : st === "lost" ? "!"
    : "+";
  const description = st === "on"
    ? (hasBattery ? t("{name}: bateria {label}. Rozłącz planszę", { name, label }) : t("{name}: odczytuję stan baterii. Rozłącz planszę", { name }))
    : st === "connecting" ? t("Łączę z planszą DGT Pegasus")
    : st === "lost" ? t("Utracono połączenie z planszą. Łączę ponownie")
    : t("Połącz planszę DGT Pegasus");
  $("#peg-label").textContent = label;
  el.setAttribute("aria-label", description);
  el.title = description;
  $("#peg-test-leds").disabled = st !== "on";
}

function pegLog(msg, tone = "") {
  const li = document.createElement("li");
  li.textContent = t(msg);
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
    if (confirm(t("Rozłączyć planszę?"))) peg.disconnect();
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
    pegLog(t("Przeglądarka: {ua}", { ua }), "muted");
    return;
  }
  try {
    await peg.pick();
    setTimeout(() => dlg.open && dlg.close(), 1200);
  } catch (e) {
    pegLog(BT_ERRORS[e.name] || t("Błąd: {msg}", { msg: e.message || e }), "bad");
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
  // dotychczasowi użytkownicy (aplikacja była tylko po polsku) zostają przy polskim
  if (!settings().lang) { settings().lang = store.data.reps.length ? "pl" : defaultLang(); store.save(); }
  setLang(settings().lang);
  translateDom();
  peg.rotated = !!settings().rotated;

  trainBoard = new BoardView($("#t-board"));
  analysisBoard = new BoardView($("#t-analysis-board"));
  browseBoard = new BoardView($("#b-board"));
  trainer = new Trainer(trainBoard);
  trainBoard.setPosition(START_FEN);

  $("nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (!b) return;
    if (trainer.running && !confirm(t("Przerwać trening?"))) return;
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

  const leaveTraining = () => {
    if (trainer.running) trainer.abort();
    go("home");
  };
  $("#t-stop").addEventListener("click", leaveTraining);
  $("#t-back-rep").addEventListener("click", leaveTraining);
  $("#t-hint").addEventListener("click", () => trainer.hintFor && trainer.hintFor());
  $("#t-flip").addEventListener("click", () => {
    trainBoard.setOrientation(trainBoard.orientation === "w" ? "b" : "w");
    analysisBoard.setOrientation(trainBoard.orientation);
  });
  $("#t-analysis-toggle").addEventListener("click", () => {
    if (trainAnalysis.explore) return returnFromTrainExplore(true);
    trainAnalysis.open = !trainAnalysis.open;
    renderTrainAnalysis(true);
  });
  $("#t-explore").addEventListener("click", startTrainExplore);
  $("#t-explore-return").addEventListener("click", () => returnFromTrainExplore());
  const rewindExplore = (reset) => {
    const e = trainAnalysis.explore;
    if (!e || e.restoring) return;
    clearTimeout(e.timer);
    if (reset) e.chess = e.fresh();
    else e.chess.undo();
    e.touched.clear();
    e.synced = !e.physical || (peg.state === "on" && !!peg.occupied() && setEq(peg.occupied(), occOf(e.chess)));
    drawTrainExplore();
    onTrainExploreOcc();
  };
  $("#t-explore-back").addEventListener("click", () => rewindExplore(false));
  $("#t-explore-reset").addEventListener("click", () => rewindExplore(true));
  $("#t-eval").addEventListener("click", (event) => {
    const uci = event.target.closest("[data-ev]")?.dataset.ev;
    const e = trainAnalysis.explore;
    if (!uci || !e || e.restoring) return;
    const move = e.chess.moves({ verbose: true }).find((m) => uciOf(m) === uci);
    if (move) playTrainExplore(move);
  });
  $("#t-db-body").addEventListener("click", (event) => {
    const san = event.target.closest("[data-san]")?.dataset.san;
    const e = trainAnalysis.explore;
    if (!san || !e || e.restoring) return;
    const move = e.chess.moves({ verbose: true }).find((m) => m.san === san);
    if (move) playTrainExplore(move);
  });
  peg.addEventListener("occ", onTrainExploreOcc);
  peg.addEventListener("state", onTrainExploreOcc);
  $("#t-eval-toggle").addEventListener("click", () => {
    trainAnalysis.eval = !trainAnalysis.eval;
    renderTrainAnalysis(true);
  });
  $("#t-db-toggle").addEventListener("click", () => {
    trainAnalysis.db = !trainAnalysis.db;
    renderTrainAnalysis(true);
  });
  $$("input[name=tdbsrc]").forEach((r) => r.addEventListener("change", () => {
    settings().dbSrc = r.value;
    store.save();
    renderTrainAnalysis(true);
  }));

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
  $("#b-eval-toggle").addEventListener("click", () => {
    settings().evalOn = !settings().evalOn;
    store.save();
    renderBrowse();
  });
  $("#b-db-toggle").addEventListener("click", () => {
    settings().dbOn = !settings().dbOn;
    store.save();
    renderBrowse();
  });
  $$("input[name=dbsrc]").forEach((r) => r.addEventListener("change", () => {
    settings().dbSrc = r.value;
    store.save();
    renderBrowse();
  }));
  $("#b-db-body").addEventListener("click", (e) => {
    const tr = e.target.closest("[data-san]");
    if (!tr || !browse.chess) return;
    const m = browse.chess.moves({ verbose: true }).find((x) => x.san === tr.dataset.san);
    if (m) browsePlay(m);
  });
  $("#li-login").addEventListener("click", () => lichess.login());
  $("#li-logout").addEventListener("click", async () => { await lichess.logout(); renderLichess(); });
  $("#li-token-save").addEventListener("click", async () => {
    const t = $("#li-token").value.trim();
    if (!t) return;
    try {
      const u = await lichess.setToken(t);
      $("#li-token").value = "";
      toast(t("Zalogowano jako {user}", { user: u }));
    } catch (err) {
      alert(err.message);
    }
    renderLichess();
  });
  $("#li-ratings").addEventListener("change", (e) => { settings().liRatings = e.target.value; store.save(); });
  $("#li-speeds").addEventListener("change", (e) => { settings().liSpeeds = e.target.value; store.save(); });
  $("#b-eval").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ev]");
    if (!b || !browse.chess) return;
    const u = b.dataset.ev;
    const m = browse.chess.moves({ verbose: true }).find((x) => uciOf(x) === u);
    if (m) browsePlay(m);
  });
  const setHdr = () => document.documentElement.style.setProperty("--hdr", $("header").offsetHeight + "px");
  setHdr();
  addEventListener("resize", setHdr);
  $("#imp-empty").addEventListener("click", () => {
    const name = $("#imp-name").value.trim() || t("Nowy repertuar");
    let color = $("#imp-color").value;
    if (color === "auto") color = "w";
    const rep = emptyRep(name, color);
    $("#imp-name").value = "";
    openBrowse(rep);
    toast(t("Pusty repertuar — wykonuj ruchy na szachownicy, żeby je dodać"));
  });
  $("#b-back").addEventListener("click", () => { browse.path.pop(); renderBrowse(); });
  $("#b-focus").addEventListener("click", () => {
    const rep = browse.rep;
    const { sans } = browseState();
    if (!browse.path.length) return;
    const line = lineText(rep.nodes[browse.root].fen, sans);
    const name = prompt(t("Nazwa fokusu (pojawi się pod repertuarem na stronie głównej):"), line);
    if (name === null) return;
    (rep.focus ||= []).push({ id: "f" + Date.now().toString(36), name: name.trim() || line, root: browse.root, path: [...browse.path], sans });
    store.save();
    go("home");
    toast(t("Fokus „{name}” jest pod repertuarem „{rep}”.", { name: name.trim() || line, rep: rep.name }));
  });
  $("#b-start").addEventListener("click", () => { browse.path = []; renderBrowse(); });
  $("#b-roots").addEventListener("change", (e) => { browse.root = e.target.value; browse.path = []; renderBrowse(); });

  $("#s-rep").addEventListener("change", renderStats);

  $("#set-new").addEventListener("change", (e) => { settings().newPerSession = Math.max(1, Math.min(50, Number(e.target.value) || 10)); store.save(); });
  $("#set-pause").addEventListener("change", (e) => { settings().pauseAfterLine = e.target.value; store.save(); });
  // flaga pokazuje język, na który się przełączy
  const other = getLang() === "en" ? "pl" : "en";
  const langBtn = $("#lang-btn");
  langBtn.textContent = other === "en" ? "🇬🇧" : "🇵🇱";
  langBtn.title = other === "en" ? "English" : "Polski";
  langBtn.setAttribute("aria-label", other === "en" ? "Switch to English" : "Przełącz na polski");
  langBtn.addEventListener("click", async () => {
    if (trainer.running && !confirm(t("Przerwać trening?"))) return;
    if (trainer.running) trainer.abort();
    settings().lang = other;
    await store.saveNow();
    location.reload();
  });
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
      const d = validateBackup(JSON.parse(await f.text()));
      if (!confirm(t("Przywrócić kopię ({n} repertuarów)? Obecne dane zostaną zastąpione.", { n: d.reps.length }))) return;
      store.data = { reps: [], log: [], settings: {}, ...d };
      await store.saveNow();
      alert(t("Przywrócono."));
      go("home");
    } catch (err) {
      alert(t("Nie udało się: ") + err.message);
    }
    e.target.value = "";
  });

  $("#peg-btn").addEventListener("click", onPegClick);
  $("#peg-test-leds").addEventListener("click", async () => {
    await peg.leds(["d4", "e4", "d5", "e5"]);
    setTimeout(() => peg.leds([]), 1500);
  });
  peg.addEventListener("state", () => {
    renderPeg();
    if (peg.state === "on") onBrowseOcc();
  });
  peg.addEventListener("log", (e) => $("#peg-dialog").open && pegLog(e.detail));
  $("#peg-close").addEventListener("click", () => $("#peg-dialog").close());
  $("#peg-retry").addEventListener("click", onPegClick);
  peg.addEventListener("battery", renderPeg);
  renderPeg();

  // ponowne połączenie z wcześniej wybraną planszą (jeśli przeglądarka pozwala)
  if (Pegasus.supported()) peg.reconnectKnown().catch(() => {});

  go("home");
  lichess.handleRedirect().then((done) => {
    if (!done) return;
    toast(t("Zalogowano do Lichess jako {user}", { user: lichess.user() }));
    go("settings");
  }).catch((err) => {
    alert(t("Logowanie do Lichess nie powiodło się: ") + err.message);
    go("settings");
  });
  window.__app = { peg, trainer }; // do diagnostyki z konsoli

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

  // Na tablecie aplikacja bywa usuwana z pamięci bez ostrzeżenia. Zapisz bieżące zmiany,
  // kiedy użytkownik ją chowa, nie czekając na krótki timer zapisu.
  // Połączona plansza nigdy nie zasypia (licznik auto-wyłączenia biegnie tylko bez połączenia),
  // więc schowana aplikacja zwalnia planszę — a po powrocie łączy się z nią z powrotem.
  let hideTimer = null;
  let autoReleased = false;
  const releaseBoard = () => {
    if (document.visibilityState !== "hidden" || trainer.running || peg.state === "off") return;
    autoReleased = true;
    peg.disconnect();
  };
  document.addEventListener("visibilitychange", () => {
    clearTimeout(hideTimer);
    if (document.visibilityState === "hidden") {
      store.saveNow().catch(console.error);
      hideTimer = setTimeout(releaseBoard, 90 * 1000);
    } else if (autoReleased && peg.state === "off") {
      autoReleased = false;
      peg.reconnectKnown().catch(() => {});
    }
  });
  // Chrome zamraża schowane karty — wtedy zwolnij planszę od razu, bo timer już nie zdąży.
  document.addEventListener("freeze", releaseBoard);
}

main();
