import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Pegasus } from "../pegasus.js";
import { importPgn, inferColor, counts, store, posKey, deleteMove, validateBackup, buildLine, focusKey, subtree, grade, START_FEN } from "../repertoire.js";

const initial = () => ({ roots: [], nodes: {}, color: "w" });

test("PGN z wariantami łączy ruchy i rozpoznaje kolor", () => {
  store.save = () => {};
  const rep = initial();
  const result = importPgn(rep, "[Event \"Test\"]\n1. e4 e5 (1... c5 2. Nf3) 2. Nf3 Nc6 *");
  assert.deepEqual(result.errors, []);
  assert.equal(result.added, 6);
  assert.equal(inferColor(rep), "w");
  assert.equal(counts(rep).total, 3);
});

test("lokalne eksporty Chessbooka wczytują się bez pominiętych wariantów", (t) => {
  store.save = () => {};
  const folder = new URL("../../", import.meta.url);
  const files = readdirSync(folder);
  const cases = [
    ["White", "w", 702, 329],
    ["Black", "b", 436, 200],
  ];
  if (cases.some(([prefix]) => !files.find((name) => name.startsWith(`${prefix} openings`) && name.endsWith(".pgn")))) {
    t.skip("Prywatne pliki PGN są tylko na komputerze użytkownika.");
    return;
  }
  for (const [prefix, color, edges, userMoves] of cases) {
    const name = files.find((file) => file.startsWith(`${prefix} openings`) && file.endsWith(".pgn"));
    const rep = initial();
    const pgn = readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
    const result = importPgn(rep, pgn);
    assert.deepEqual(result.errors, [], name);
    assert.equal(result.added, edges, name);
    assert.equal(inferColor(rep), color, name);
    rep.color = color;
    assert.equal(counts(rep).total, userMoves, name);
  }
});

test("Pegasus nie uznaje starego ani częściowego odczytu za stan po ponownym połączeniu", async () => {
  const board = new Pegasus();
  const sent = [];
  board._startTimers = () => {};
  board.device = {
    name: "Pegasus",
    gatt: { connect: async () => ({ getPrimaryService: async () => ({
      getCharacteristic: async () => ({ startNotifications: async () => {}, addEventListener: () => {} }),
    }) }) },
  };
  board.send = async (bytes) => { sent.push(bytes[0]); };
  board.occ = new Uint8Array(64).fill(1); // przestarzały zrzut sprzed rozłączenia
  board.leds(["e2", "e4"]);

  const connecting = board._connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(board.state, "connecting");
  assert.equal(board.occupied(), null);
  board._handle([142, 0, 5, 40, 1]); // a3 — pojedyncza zmiana nie opisuje planszy
  assert.equal(board.occupied(), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sent.includes(66)); // prośba o pełny zrzut została wysłana
  assert.equal(board.state, "connecting");

  const occ = new Array(64).fill(0);
  occ[52] = 1; // e2
  board._handle([134, 0, 67, ...occ]);
  await connecting;
  assert.equal(board.state, "on");
  assert.deepEqual([...board.occupied()], ["e2"]);
  assert.deepEqual(board._ledState.squares, ["e2", "e4"]);
  assert.ok(sent.indexOf(96, sent.indexOf(66)) > sent.indexOf(66)); // diody wracają po zrzucie
});

test("nieudana próba automatycznego ponownego połączenia nie zostawia stanu „Łączę”", async () => {
  const board = new Pegasus();
  const oldNavigator = globalThis.navigator;
  const dev = { name: "Pegasus", addEventListener: () => {}, gatt: { connected: false } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { bluetooth: { getDevices: async () => [dev] } } });
  try {
    board._connect = async () => { board._setState("connecting"); throw new Error("brak połączenia"); };
    assert.equal(await board.reconnectKnown(), false);
    assert.equal(board.state, "off");
    assert.equal(board.wantConnected, false);
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: oldNavigator });
  }
});

test("usunięcie gałęzi zachowuje pozycje osiągalne transpozycją", () => {
  const rep = initial();
  importPgn(rep, "1. Nf3 (1. d4 Nf6 2. Nf3 d5 3. c4) d5 2. d4 Nf6 3. c4 *");
  const root = rep.roots[0];
  const shared = Object.values(rep.nodes).find((node) => node.moves.c2c4 && node.fen.split(" ")[1] === "w");
  assert.ok(shared, "wspólna pozycja istnieje");
  const key = posKey(shared.fen);
  deleteMove(rep, root, "g1f3");
  assert.ok(rep.nodes[key], "wspólna pozycja pozostała");
  assert.ok(rep.nodes[key].moves.c2c4, "ruch po transpozycji pozostał");
});

test("przywracanie odrzuca uszkodzoną kopię przed zmianą danych", () => {
  const rep = initial();
  rep.id = "test";
  rep.name = "Test";
  importPgn(rep, "1. e4 e5 *");
  const backup = { reps: [rep], log: [], settings: {} };
  assert.equal(validateBackup(backup), backup);
  delete rep.nodes[Object.values(rep.nodes[rep.roots[0]].moves)[0].to];
  assert.throws(() => validateBackup(backup), /ruch bez dalszej pozycji/);
});

test("fokus: linie przechodzą przez wybraną pozycję, cele tylko za nią", () => {
  store.save = () => {};
  const rep = initial();
  importPgn(rep, "1. e4 c5 (1... e5 2. Nf3) 2. d4 cxd4 3. c3 dxc3 (3... d3 4. Bxd3) 4. Nxc3 Nc6 5. Nf3 *");
  const root = posKey(START_FEN);
  const morra = ["e2e4", "c7c5", "d2d4", "c5d4", "c2c3", "d4c3"];
  const focus = { id: "f", name: "Morra przyjęty", root, path: morra };
  const key = focusKey(rep, focus);
  assert.ok(key);
  const keys = subtree(rep, key);
  assert.equal(counts(rep, Date.now(), keys).total, 2, "Nxc3 i Nf3");
  assert.equal(counts(rep).total, 7);

  const line = buildLine(rep, "learn", { focus });
  assert.deepEqual(line.steps.map((s) => s.san), ["e4", "c5", "d4", "cxd4", "c3", "dxc3", "Nxc3", "Nc6", "Nf3"]);
  assert.deepEqual(line.steps.filter((s) => s.target).map((s) => s.san), ["Nxc3", "Nf3"]);

  // nic nowego za fokusem → brak linii, choć gdzie indziej są nowe ruchy
  for (const s of line.steps) if (s.target) grade(s.edge, true);
  assert.equal(buildLine(rep, "learn", { focus }), null);
  assert.ok(buildLine(rep, "learn"));
  // przegląd całości bierze poznane ruchy bez względu na termin
  assert.equal(buildLine(rep, "review", { focus }), null);
  const drill = buildLine(rep, "drill", { focus });
  assert.deepEqual(drill.steps.filter((s) => s.target).map((s) => s.san), ["Nxc3", "Nf3"]);
  const done = new Set(drill.steps.filter((s) => s.target).map((s) => s.fen + s.uci));
  assert.equal(buildLine(rep, "drill", { focus, exclude: done }), null);

  // usunięty ruch na ścieżce — fokus nieaktualny
  deleteMove(rep, Object.keys(rep.nodes).find((k) => rep.nodes[k].moves.c2c3), "c2c3");
  assert.equal(focusKey(rep, focus), null);
  assert.equal(buildLine(rep, "drill", { focus }), null);
});

test("tłumaczenie: angielski ze zmiennymi, brak wpisu zostaje po polsku", async () => {
  const { t, setLang } = await import("../i18n.js");
  setLang("en");
  try {
    assert.equal(t("Zagraj: {san}", { san: "Nf3" }), "Play: Nf3");
    assert.equal(t("Tekst bez tłumaczenia"), "Tekst bez tłumaczenia");
    assert.equal(t("za {n} dni", { n: 3 }), "in 3 days");
  } finally {
    setLang("pl");
  }
  assert.equal(t("Zagraj: {san}", { san: "Nf3" }), "Zagraj: Nf3");
});
