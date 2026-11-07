// Sterownik DGT Pegasus przez Web Bluetooth (Nordic UART).
// Protokół: https://dgtcentaurmods.github.io/pegasus-protocol (nieoficjalny),
// sprawdzony na planszy „Pegasus Alutka” — patrz ../NOTATKI.md.

const NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // zapis: tablet -> plansza
const TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // notify: plansza -> tablet

const DEV_KEY = [99, 7, 190, 245, 174, 221, 169, 95, 0];
const RESET = [0x40]; // "@"
const FIELD_UPDATES = [0x44]; // "D"
const BOARD_DUMP = [0x42]; // "B"
const BATTERY = [0x4c]; // "L"
const LEDS_OFF = [96, 2, 0, 0];

const FILES = "abcdefgh";

export class Pegasus extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.rx = null;
    this.occ = null; // Uint8Array(64), indeks Pegasusa: 0 = a8 … 63 = h1
    this.rotated = false; // plansza obrócona o 180° (czarne przy graczu)
    this.battery = null; // {pct, charging}
    this.state = "off"; // off | connecting | on | lost
    this.buf = [];
    this.queue = Promise.resolve();
    this.wantConnected = false;
    this._timers = [];
    this._ledState = { squares: [], options: {} };
  }

  static supported() {
    return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
  }

  sqName(i) {
    if (this.rotated) i = 63 - i;
    return FILES[i % 8] + String(8 - Math.floor(i / 8));
  }

  sqIndex(name) {
    const i = (8 - Number(name[1])) * 8 + FILES.indexOf(name[0]);
    return this.rotated ? 63 - i : i;
  }

  /** Zbiór zajętych pól (nazwy), albo null gdy jeszcze brak odczytu. */
  occupied() {
    if (!this.occ) return null;
    const s = new Set();
    for (let i = 0; i < 64; i++) if (this.occ[i]) s.add(this.sqName(i));
    return s;
  }

  log(msg) {
    this.dispatchEvent(new CustomEvent("log", { detail: msg }));
  }

  _setState(st, detail) {
    this.state = st;
    this.dispatchEvent(new CustomEvent("state", { detail: { state: st, ...detail } }));
  }

  /** Wybór planszy (wymaga gestu użytkownika). */
  async pick() {
    this.log("Otwieram listę urządzeń Bluetooth…");
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS] }, { namePrefix: "Pegasus" }, { namePrefix: "DGT" }],
      optionalServices: [NUS],
    });
    this.log(`Wybrano: ${dev.name || "(bez nazwy)"}`);
    if (this.device !== dev) {
      this.device = dev;
      dev.addEventListener("gattserverdisconnected", () => {
        if (this.device === dev) this._onDisconnect();
      });
    }
    this.wantConnected = true;
    await this._connect();
  }

  /** Próba połączenia z wcześniej sparowaną planszą bez okna wyboru. */
  async reconnectKnown() {
    if (!navigator.bluetooth.getDevices) return false;
    const devs = await navigator.bluetooth.getDevices();
    const dev = devs.find((d) => /pegasus|dgt/i.test(d.name || ""));
    if (!dev) return false;
    if (this.device !== dev) {
      this.device = dev;
      dev.addEventListener("gattserverdisconnected", () => {
        if (this.device === dev) this._onDisconnect();
      });
    }
    this.wantConnected = true;
    try {
      await this._connect();
      return true;
    } catch {
      this.disconnect();
      return false;
    }
  }

  async _connect() {
    this._setState("connecting");
    // Odczyt sprzed rozłączenia nie opisuje już bieżącej pozycji planszy.
    this.occ = null;
    const timeout = (p, ms, what) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what}: brak odpowiedzi po ${ms / 1000} s`)), ms);
      Promise.resolve(p).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
    this.log("Łączę z planszą…");
    const server = await timeout(this.device.gatt.connect(), 20000, "Połączenie");
    this.log("Połączono, szukam usługi UART…");
    const svc = await timeout(server.getPrimaryService(NUS), 10000, "Usługa UART");
    this.rx = await svc.getCharacteristic(RX);
    const tx = await svc.getCharacteristic(TX);
    await tx.startNotifications();
    if (this._txBound !== tx) {
      // przy ponownym połączeniu ta sama charakterystyka — nie dubluj nasłuchu
      tx.addEventListener("characteristicvaluechanged", (e) => this._onNotify(e.target.value));
      this._txBound = tx;
    }
    this.buf = [];
    this.log("Wysyłam klucz i włączam powiadomienia o polach…");
    for (const cmd of [DEV_KEY, RESET, FIELD_UPDATES, LEDS_OFF]) await this.send(cmd, 120);
    const snapshot = this._awaitSnapshot(5000);
    await this.dump();
    await snapshot;
    this.log("Gotowe ✓");
    this._setState("on", { name: this.device.name });
    await this._writeLeds(this._ledState.squares, this._ledState.options);
    this.readBattery();
    this._startTimers();
  }

  _awaitSnapshot(ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeEventListener("snapshot", onSnapshot);
        reject(new Error("Plansza nie przesłała stanu pól. Wyłącz i włącz ją, a potem połącz ponownie."));
      }, ms);
      const onSnapshot = () => {
        clearTimeout(timer);
        this.removeEventListener("snapshot", onSnapshot);
        resolve();
      };
      this.addEventListener("snapshot", onSnapshot);
    });
  }

  _startTimers() {
    this._stopTimers();
    // zabezpieczenie, gdyby zgubiło się zdarzenie o polu
    this._timers.push(setInterval(() => this.state === "on" && this.dump(), 5000));
    this._timers.push(setInterval(() => this.state === "on" && this.readBattery(), 5 * 60 * 1000));
  }

  _stopTimers() {
    this._timers.forEach(clearInterval);
    this._timers = [];
  }

  async _onDisconnect() {
    this._stopTimers();
    this.rx = null;
    this.occ = null;
    if (!this.wantConnected) {
      this._setState("off");
      return;
    }
    if (this._reconnecting) return;
    this._reconnecting = true;
    this._setState("lost");
    try {
      for (let attempt = 0; this.wantConnected; attempt++) {
        await new Promise((r) => setTimeout(r, Math.min(1000 * (attempt + 1), 5000)));
        if (!this.wantConnected) break;
        try {
          await this._connect();
          return;
        } catch {
          if (this.wantConnected) this._setState("lost", { attempt: attempt + 1 });
        }
      }
    } finally {
      this._reconnecting = false;
    }
  }

  disconnect() {
    this.wantConnected = false;
    this._stopTimers();
    this.occ = null;
    if (this.device && this.device.gatt.connected) {
      this.leds([]).finally(() => this.device.gatt.disconnect());
    }
    this._setState("off");
  }

  /** Wysyłanie poleceń po kolei (GATT nie lubi równoległych zapisów). */
  send(bytes, pause = 40) {
    const job = this.queue.then(async () => {
      if (!this.rx) return;
      const data = new Uint8Array(bytes);
      if (this.rx.properties.write) await this.rx.writeValueWithResponse(data);
      else await this.rx.writeValueWithoutResponse(data);
      await new Promise((r) => setTimeout(r, pause));
    });
    this.queue = job.catch(() => {});
    return job;
  }

  dump() {
    return this.send(BOARD_DUMP).catch(() => {});
  }

  readBattery() {
    return this.send(BATTERY).catch(() => {});
  }

  /** Zapala diody na podanych polach (pusta lista = zgaś). */
  leds(squares, { blink = 0, speed = 3, intensity = 3 } = {}) {
    this._ledState = { squares: [...(squares || [])], options: { blink, speed, intensity } };
    return this._writeLeds(this._ledState.squares, this._ledState.options);
  }

  _writeLeds(squares, { blink = 0, speed = 3, intensity = 3 } = {}) {
    if (!squares || !squares.length) return this.send(LEDS_OFF).catch(() => {});
    const body = [5, speed, blink, intensity, ...squares.map((s) => this.sqIndex(s)), 0];
    return this.send([96, body.length, ...body]).catch(() => {});
  }

  _onNotify(view) {
    for (let i = 0; i < view.byteLength; i++) this.buf.push(view.getUint8(i));
    const buf = this.buf;
    while (buf.length >= 3) {
      if (!(buf[0] & 0x80)) {
        buf.shift();
        continue;
      }
      const n = (buf[1] << 7) | buf[2];
      if (n < 3) {
        buf.shift();
        continue;
      }
      if (buf.length < n) break;
      const msg = buf.splice(0, n);
      this._handle(msg);
    }
  }

  _handle(msg) {
    const t = msg[0];
    if (t === 134 && msg.length === 67) {
      const occ = Uint8Array.from(msg.slice(3));
      const changed = !this.occ || occ.some((v, i) => v !== this.occ[i]);
      this.occ = occ;
      if (changed) this.dispatchEvent(new CustomEvent("occ", { detail: { square: null } }));
      this.dispatchEvent(new Event("snapshot"));
    } else if (t === 142 && msg.length >= 5) {
      if (msg[3] < 64) {
        // Zdarzenie pojedynczego pola nie wystarcza do odtworzenia całej planszy.
        if (!this.occ) return;
        this.occ[msg[3]] = msg[4];
        this.dispatchEvent(
          new CustomEvent("occ", { detail: { square: this.sqName(msg[3]), placed: !!msg[4] } })
        );
      }
    } else if (t === 160 && msg.length >= 12) {
      // poziom to wprost procenty; stan 1 = ładowanie, 2 = bateria (patrz NOTATKI.md)
      this.battery = { pct: msg[3], charging: msg[11] === 1 };
      this.dispatchEvent(new CustomEvent("battery", { detail: this.battery }));
    }
  }
}
