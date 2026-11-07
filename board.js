// Szachownica na ekranie: wyświetlanie pozycji, strzałki, podświetlenia, ruchy dotykiem.

const FILES = "abcdefgh";
const PIECE_IMG = {};
for (const c of "wb") for (const p of "KQRBNP") PIECE_IMG[c + p] = `piece/${c}${p}.svg`;

const ARROW_COLORS = { G: "var(--arrow-g)", R: "var(--arrow-r)", B: "var(--arrow-b)", Y: "var(--arrow-y)" };

function parseFen(fen) {
  const map = {};
  const rows = fen.split(" ")[0].split("/");
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else {
        const color = ch === ch.toUpperCase() ? "w" : "b";
        map[FILES[f] + (8 - r)] = color + ch.toUpperCase();
        f++;
      }
    }
  });
  return map;
}

export class BoardView {
  constructor(el, { onMove } = {}) {
    this.el = el;
    this.onMove = onMove;
    this.orientation = "w";
    this.pieces = {};
    this.hl = {};
    this.arrows = [];
    this.diff = { missing: [], extra: [] };
    this.dests = null; // (square) => [squares] albo null gdy brak ruchów
    this.selected = null;
    el.classList.add("board");
    this.grid = document.createElement("div");
    this.grid.className = "board-grid";
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("viewBox", "0 0 8 8");
    this.svg.classList.add("board-arrows");
    el.append(this.grid, this.svg);
    this.squares = {};
    for (let i = 0; i < 64; i++) {
      const sq = document.createElement("div");
      sq.className = "sq";
      this.grid.append(sq);
    }
    this._layout();
    this.grid.addEventListener("pointerdown", (e) => this._down(e));
    this.grid.addEventListener("pointerup", (e) => this._up(e));
  }

  _layout() {
    const cells = [...this.grid.children];
    this.squares = {};
    cells.forEach((cell, i) => {
      const r = Math.floor(i / 8), f = i % 8;
      const file = this.orientation === "w" ? f : 7 - f;
      const rank = this.orientation === "w" ? 8 - r : r + 1;
      const name = FILES[file] + rank;
      cell.dataset.sq = name;
      cell.classList.toggle("light", (file + rank) % 2 === 1);
      cell.classList.toggle("dark", (file + rank) % 2 === 0);
      cell.dataset.file = r === 7 ? FILES[file] : "";
      cell.dataset.rank = f === 0 ? String(rank) : "";
      this.squares[name] = cell;
    });
    this.render();
  }

  setOrientation(c) {
    if (c === this.orientation) return;
    this.orientation = c;
    this._layout();
  }

  setPosition(fen) {
    this.pieces = parseFen(fen);
    this.selected = null;
    this.render();
  }

  /** hl: {last:[a,b], hint:[..], good:[..], bad:[..], check: sq} */
  setHighlights(hl) {
    this.hl = hl || {};
    this.render();
  }

  setArrows(arrows) {
    this.arrows = arrows || [];
    this._renderArrows();
  }

  setDiff(diff) {
    this.diff = diff || { missing: [], extra: [] };
    this.render();
  }

  setInteractive(destsFn) {
    this.dests = destsFn;
    this.selected = null;
    this.el.classList.toggle("interactive", !!destsFn);
    this.render();
  }

  render() {
    const hl = this.hl;
    const mark = (list, sq) => !!(list && list.includes(sq));
    const dests = this.selected && this.dests ? this.dests(this.selected) : [];
    for (const [name, cell] of Object.entries(this.squares)) {
      const p = this.pieces[name];
      cell.style.backgroundImage = p ? `url(${PIECE_IMG[p]})` : "";
      cell.classList.toggle("has-piece", !!p);
      cell.classList.toggle("last", mark(hl.last, name));
      cell.classList.toggle("hint", mark(hl.hint, name));
      cell.classList.toggle("good", mark(hl.good, name));
      cell.classList.toggle("bad", mark(hl.bad, name));
      cell.classList.toggle("check", hl.check === name);
      cell.classList.toggle("selected", this.selected === name);
      cell.classList.toggle("dest", dests.includes(name));
      cell.classList.toggle("missing", this.diff.missing.includes(name));
      cell.classList.toggle("extra", this.diff.extra.includes(name));
    }
    this._renderArrows();
  }

  _xy(sq) {
    const f = FILES.indexOf(sq[0]), r = Number(sq[1]) - 1;
    return this.orientation === "w" ? [f + 0.5, 7 - r + 0.5] : [7 - f + 0.5, r + 0.5];
  }

  _renderArrows() {
    const NS = "http://www.w3.org/2000/svg";
    this.svg.replaceChildren();
    const defs = document.createElementNS(NS, "defs");
    this.svg.append(defs);
    this.arrows.forEach((a, i) => {
      const color = ARROW_COLORS[a.c] || ARROW_COLORS.G;
      if (a.sq) {
        const [x, y] = this._xy(a.sq);
        const c = document.createElementNS(NS, "circle");
        Object.entries({ cx: x, cy: y, r: 0.45, fill: "none", stroke: color, "stroke-width": 0.08, opacity: 0.85 }).forEach(([k, v]) => c.setAttribute(k, v));
        this.svg.append(c);
        return;
      }
      const m = document.createElementNS(NS, "marker");
      Object.entries({ id: "ah" + i, viewBox: "0 0 10 10", refX: 3, refY: 5, markerWidth: 3.2, markerHeight: 3.2, orient: "auto" }).forEach(([k, v]) => m.setAttribute(k, v));
      const tri = document.createElementNS(NS, "path");
      tri.setAttribute("d", "M0,0 L10,5 L0,10 z");
      tri.setAttribute("fill", color);
      m.append(tri);
      defs.append(m);
      const [x1, y1] = this._xy(a.from);
      let [x2, y2] = this._xy(a.to);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const k = (len - 0.35) / len;
      x2 = x1 + (x2 - x1) * k;
      y2 = y1 + (y2 - y1) * k;
      const line = document.createElementNS(NS, "line");
      Object.entries({ x1, y1, x2, y2, stroke: color, "stroke-width": 0.16, "stroke-linecap": "round", "marker-end": `url(#ah${i})`, opacity: 0.85 }).forEach(([k2, v]) => line.setAttribute(k2, v));
      this.svg.append(line);
    });
  }

  _sqAt(e) {
    const cell = e.target.closest(".sq");
    return cell ? cell.dataset.sq : null;
  }

  _down(e) {
    if (!this.dests) return;
    const sq = this._sqAt(e);
    if (!sq) return;
    if (this.selected && this.selected !== sq && this.dests(this.selected).includes(sq)) {
      const from = this.selected;
      this.selected = null;
      this.render();
      this.onMove && this.onMove(from, sq);
      return;
    }
    if (this.dests(sq).length) {
      this.selected = sq;
      this._dragFrom = sq;
      try { this.grid.releasePointerCapture(e.pointerId); } catch {}
    } else {
      this.selected = null;
    }
    this.render();
  }

  _up(e) {
    if (!this.dests || !this._dragFrom) return;
    const from = this._dragFrom;
    this._dragFrom = null;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest(".sq");
    const sq = cell && cell.dataset.sq;
    if (sq && sq !== from && this.dests(from).includes(sq)) {
      this.selected = null;
      this.render();
      this.onMove && this.onMove(from, sq);
    }
  }
}
