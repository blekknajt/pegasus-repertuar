// Lichess: logowanie OAuth (PKCE, bez rejestracji aplikacji) i baza debiutów (opening explorer).
// Token trzymamy w localStorage tej strony — tylko na tym urządzeniu.
// Odpowiedzi bazy są zapamiętywane na urządzeniu (IndexedDB) — działają po przeładowaniu i bez sieci.
import { persistentCache } from "./cache.js";

const CLIENT_ID = "pegasus-repertuar";
const TOKEN_KEY = "lichessToken";
const USER_KEY = "lichessUser";
const PKCE_KEY = "lichessPkce";

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const redirectUri = () => location.origin + location.pathname;

function lsGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function lsSet(k, v) {
  try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {}
}

export const lichess = {
  token: () => lsGet(TOKEN_KEY),
  user: () => lsGet(USER_KEY),

  async login() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    lsSet(PKCE_KEY, JSON.stringify({ verifier, state }));
    const q = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(),
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
    });
    location.href = `https://lichess.org/oauth?${q}`;
  },

  /** Po powrocie z Lichess (?code=…&state=…) wymienia kod na token. Zwraca true, jeśli coś obsłużono. */
  async handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.has("code") && !p.has("error")) return false;
    history.replaceState(null, "", redirectUri());
    if (p.has("error")) throw new Error(p.get("error_description") || p.get("error"));
    const saved = JSON.parse(lsGet(PKCE_KEY) || "null");
    lsSet(PKCE_KEY, null);
    if (!saved || saved.state !== p.get("state")) throw new Error("Logowanie przerwane (niezgodny stan) — spróbuj jeszcze raz.");
    const r = await fetch("https://lichess.org/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: p.get("code"),
        code_verifier: saved.verifier,
        redirect_uri: redirectUri(),
        client_id: CLIENT_ID,
      }),
    });
    if (!r.ok) throw new Error(`Lichess nie wydał tokenu (${r.status}).`);
    const { access_token } = await r.json();
    await this.setToken(access_token);
    return true;
  },

  /** Zapisuje token (z logowania albo wklejony ręcznie) i sprawdza go. */
  async setToken(token) {
    const r = await fetch("https://lichess.org/api/account", { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error("Token nie działa (Lichess go odrzucił).");
    const acc = await r.json();
    lsSet(TOKEN_KEY, token);
    lsSet(USER_KEY, acc.username);
    return acc.username;
  },

  async logout() {
    const t = this.token();
    lsSet(TOKEN_KEY, null);
    lsSet(USER_KEY, null);
    if (t) fetch("https://lichess.org/api/token", { method: "DELETE", headers: { Authorization: `Bearer ${t}` } }).catch(() => {});
  },
};

const cache = persistentCache("db", 300);

/**
 * Statystyki ruchów z pozycji. db: "lichess" | "masters".
 * Zwraca {total, opening, moves: [{uci, san, games, white, draws, black, rating}]}.
 */
export async function explore(fen, db, { ratings, speeds } = {}) {
  const token = lichess.token();
  if (!token) throw Object.assign(new Error("Zaloguj się do Lichess w Ustawieniach, żeby widzieć bazę partii."), { code: "auth" });
  const q = new URLSearchParams({ fen, moves: "15", topGames: "0", recentGames: "0" });
  if (db === "lichess") {
    q.set("variant", "standard");
    q.set("speeds", speeds || "blitz,rapid,classical");
    q.set("ratings", ratings || "1800,2000,2200,2500");
  }
  const url = `https://explorer.lichess.ovh/${db}?${q}`;
  const hit = await cache.get(url).catch(() => undefined);
  if (hit) return hit;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 401) throw Object.assign(new Error("Lichess odrzucił logowanie — zaloguj się ponownie w Ustawieniach."), { code: "auth" });
  if (r.status === 429) throw new Error("Za dużo zapytań do bazy Lichess — odczekaj minutę.");
  if (!r.ok) throw new Error(`Baza Lichess odpowiedziała błędem ${r.status}.`);
  const d = await r.json();
  const res = {
    total: d.white + d.draws + d.black,
    opening: d.opening,
    moves: d.moves.map((m) => ({
      uci: m.uci, san: m.san, games: m.white + m.draws + m.black,
      white: m.white, draws: m.draws, black: m.black, rating: m.averageRating,
    })),
  };
  cache.set(url, res);
  return res;
}
