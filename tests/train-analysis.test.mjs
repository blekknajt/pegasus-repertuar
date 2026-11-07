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

test("próbne ruchy na Pegasusie nie zaliczają powtórki i wymagają przywrócenia pozycji", async () => {
  const elements = new Map();
  const document = {
    body: { dataset: { view: "train" } },
    querySelector(s) {
      if (!elements.has(s)) elements.set(s, { hidden: false, disabled: false, textContent: "", classList: { toggle() {} }, setAttribute() {} });
      return elements.get(s);
    },
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    Chess, Pegasus: FakePeg, BoardView: FakeBoard,
    Engine: class { constructor() { this.job = 0; } stopLocal() {} },
    store: { data: { settings: {} } }, posKey: () => "none", lineText: (_fen, moves) => moves.join(" "),
    document, setTimeout, clearTimeout, console, Event, EventTarget, navigator: {}, window: {},
  });
  const file = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const source = file.slice(file.indexOf("const VERSION"), file.lastIndexOf("\nmain();"));
  vm.runInContext(source + `\nglobalThis.h = { peg, Trainer, trainAnalysis, occOf, startTrainExplore, returnFromTrainExplore, onTrainExploreOcc, setup() { trainBoard = new BoardView(); analysisBoard = new BoardView(); trainer = new Trainer(trainBoard); return trainer; } };`, context);
  const h = context.h;
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
