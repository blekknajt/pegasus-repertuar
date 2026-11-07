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
    this.layer = document.createElement("div");
    this.layer.className = "board-pieces";
    this.sprites = []; // {el, piece, sq}
    el.append(this.grid, this.layer, this.svg);
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
      cell.classList.toggle("light", (file + rank) % 2 === 0); // a1 (0+1) ciemne, h1 jasne
      cell.classList.toggle("dark", (file + rank) % 2 === 1);
      cell.dataset.file = r === 7 ? FILES[file] : "";
      cell.dataset.rank = f === 0 ? String(rank) : "";
      this.squares[name] = cell;
    });
    this.render();
    this._placeSprites(false);
  }

  setOrientation(c) {
    if (c === this.orientation) return;
    this.orientation = c;
    this._layout();
  }

  setPosition(fen) {
    const next = parseFen(fen);
    const same = Object.keys(next).length === Object.keys(this.pieces).length &&
      Object.entries(next).every(([sq, p]) => this.pieces[sq] === p);
    this.pieces = next;
    this.selected = null;
    this.render();
    if (!same) this._syncSprites();
  }

  /** Dopasowuje figury na ekranie do pozycji: przesuwa te same bierki zamiast je podmieniać. */
  _syncSprites() {
    const want = { ...this.pieces };
    const keep = [];
    let free = [];
    // 1) bierki, które stoją tam gdzie trzeba
    for (const sp of this.sprites) {
      if (want[sp.sq] === sp.piece) {
        keep.push(sp);
        delete want[sp.sq];
      } else free.push(sp);
    }
    // 2) ruch: najbliższa wolna bierka tego samego rodzaju
    const dist = (a, b) => Math.abs(a.charCodeAt(0) - b.charCodeAt(0)) + Math.abs(a[1] - b[1]);
    const moved = [];
    for (const [sq, piece] of Object.entries(want)) {
      const cands = free.filter((sp) => sp.piece === piece).sort((x, y) => dist(x.sq, sq) - dist(y.sq, sq));
      if (cands.length) {
        const sp = cands[0];
        free = free.filter((x) => x !== sp);
        sp.sq = sq;
        moved.push(sp);
      } else {
        const img = document.createElement("img");
        img.className = "piece appear";
        img.src = PIECE_IMG[piece];
        img.alt = "";
        img.draggable = false;
        img.style.transition = "opacity .25s";
        img.style.transform = this._tf(sq);
        this.layer.append(img);
        const sp = { el: img, piece, sq };
        moved.push(sp);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          img.classList.remove("appear");
          img.style.transition = "";
        }));
      }
    }
    // 3) zbite / zdjęte — znikają pod spodem
    for (const sp of free) {
      sp.el.classList.add("gone");
      setTimeout(() => sp.el.remove(), 260);
    }
    this.sprites = keep.concat(moved);
    for (const sp of moved) sp.el.style.zIndex = 2;
    for (const sp of keep) sp.el.style.zIndex = 1;
    this._placeSprites(true);
  }

  _tf(sq) {
    const f = FILES.indexOf(sq[0]), r = Number(sq[1]) - 1;
    const x = this.orientation === "w" ? f : 7 - f;
    const y = this.orientation === "w" ? 7 - r : r;
    return `translate(${x * 100}%, ${y * 100}%)`;
  }

  _placeSprites(animate) {
    this.layer.classList.toggle("no-anim", !animate);
    for (const sp of this.sprites) sp.el.style.transform = this._tf(sp.sq);
    if (!animate) void this.layer.offsetWidth;
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
