import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Pegasus } from "../pegasus.js";
import { importPgn, inferColor, counts, store, posKey, deleteMove, validateBackup } from "../repertoire.js";

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
