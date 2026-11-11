import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Chess } from "../lib/chess.js";

class FakePeg extends EventTarget {
  constructor() { super(); this.state = "on"; this.occ = null; }
  occupied() { return this.occ; }
  leds() {}
  update(occ, square) {
    this.occ = occ;
    const event = new Event("occ");
    event.detail = { square };
    this.dispatchEvent(event);
  }
}

class FakeBoard {
  constructor() { this.orientation = "w"; this.arrows = []; }
  setPosition() {} setHighlights() {} setArrows(a) { this.arrows = a; }
  setInteractive() {} setDiff() {} setOrientation(o) { this.orientation = o; }
}

class FakeElement extends EventTarget {
  constructor() { super(); this.hidden = false; this.disabled = false; this.textContent = ""; this.dataset = {}; this.classList = { toggle() {} }; }
  setAttribute() {}
  click() { this.dispatchEvent(new Event("click")); }
}

function load() {
  const elements = new Map();
  const document = {
    body: { dataset: { view: "train" } },
    querySelector(s) {
      if (!elements.has(s)) elements.set(s, new FakeElement());
      return elements.get(s);
    },
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    Chess, Pegasus: FakePeg, BoardView: FakeBoard,
    Engine: class { constructor() { this.job = 0; } stopLocal() {} },
    store: { data: { settings: {} }, save() {}, logReview() {} }, posKey: () => "none", lineText: (_fen, moves) => moves.join(" "),
    document, setTimeout, clearTimeout, console, Event, EventTarget, navigator: {}, window: {},
  });
  const file = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const source = file.slice(file.indexOf("const VERSION"), file.lastIndexOf("\nmain();"));
  vm.runInContext(source + `\nglobalThis.h = { peg, Trainer, trainAnalysis, occOf, startTrainExplore, returnFromTrainExplore, onTrainExploreOcc, settings, setup() { trainBoard = new BoardView(); analysisBoard = new BoardView(); trainer = new Trainer(trainBoard); return trainer; } };`, context);
  context.h.$ = (s) => document.querySelector(s);
  return context.h;
}

test("próbne ruchy na Pegasusie nie zaliczają powtórki i wymagają przywrócenia pozycji", async () => {
  const h = load();
  const trainer = h.setup();
  trainer.running = true;
  trainer.usingBoard = true;
  trainer.pos = new Chess();
  trainer.rep = { color: "w", nodes: {} };
  h.trainAnalysis.open = true;
  const start = h.occOf(trainer.pos);
  h.peg.occ = new Set(start);
  let result;
  const waiting = trainer.waitUserMove("e2e4").then((move) => { result = move; });
  h.peg.addEventListener("occ", h.onTrainExploreOcc);
  h.startTrainExplore();

  const d4 = new Set(start); d4.delete("d2"); d4.add("d4");
  h.peg.update(d4, "d4");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(h.trainAnalysis.explore.chess.history().join(" "), "d4");
  assert.equal(result, undefined);

  h.returnFromTrainExplore();
  assert.equal(h.trainAnalysis.explore.restoring, true);
  assert.equal(result, undefined);
  h.peg.update(new Set(start), "d2");
  assert.equal(h.trainAnalysis.explore, null);
  assert.equal(result, undefined);

  const e4 = new Set(start); e4.delete("e2"); e4.add("e4");
  h.peg.update(e4, "e4");
  await waiting;
  assert.equal(result.san, "e4");

  trainer.usingBoard = false;
  let timerFinished = false;
  const timer = trainer.sleep(20).then(() => { timerFinished = true; });
  h.startTrainExplore();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(timerFinished, false, "trening czeka także podczas automatycznych ruchów");
  h.returnFromTrainExplore();
  await timer;
  assert.equal(timerFinished, true);
});

test("po linii z błędem trening czeka na „Dalej”, a analiza zna ruchy tej linii", async () => {
  const h = load();
  const trainer = h.setup();
  const start = new Chess();
  const line = [{ uci: "e2e4", san: "e4" }, { uci: "e7e5", san: "e5" }];
  const nodes = {};
  const c = new Chess();
  for (const s of line) {
    s.key = c.fen(); s.fen = c.fen(); s.user = c.turn() === "w"; s.target = s.user;
    s.edge = { srs: null };
    nodes[s.key] = { fen: c.fen(), moves: { [s.uci]: s.edge } };
    c.move(s.san);
  }
  nodes[c.fen()] = { fen: c.fen(), moves: {} };
  trainer.rep = { color: "w", nodes };
  trainer.running = true;
  trainer.usingBoard = false;
  trainer.stats = { ok: 0, fail: 0, learned: 0 };
  trainer.retry = new Set();
  trainer.played = [];
  // ruch użytkownika: od razu podpowiedź (= błąd), potem poprawny ruch
  trainer.waitUserMove = async (uci) => { trainer.hintFor?.(); return trainer.verbose(uci); };
  trainer.fail = () => { trainer.stats.fail++; };
  trainer.renderStats = () => {};
  trainer.opponentMove = async (step) => { trainer.apply(trainer.verbose(step.uci)); };
  h.settings().pauseAfterLine = "error";

  let done = false;
  const playing = trainer.playLine({ root: start.fen(), steps: line }, "quiz").then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(done, false, "pauza po błędzie");
  assert.equal(h.$("#t-next").hidden, false);

  h.startTrainExplore();
  assert.deepEqual(h.trainAnalysis.explore.chess.history(), ["e4", "e5"], "cofanie w analizie sięga do miejsca błędu");
  assert.equal(h.$("#t-next").disabled, true);
  h.returnFromTrainExplore();
  assert.equal(h.$("#t-next").disabled, false);

  h.$("#t-next").click();
  await playing;
  assert.equal(h.$("#t-next").hidden, true);
});
