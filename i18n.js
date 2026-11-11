// Tłumaczenia interfejsu. Kluczem jest tekst polski; brak wpisu → zostaje polski.
// Teksty ze zmiennymi mają znaczniki {nazwa}: t("Zagraj: {san}", { san }).
// Stałe napisy w HTML i w szablonach tłumaczy obserwator DOM (translateDom).
// Słowniki są w lang/*.js; każdy ma te same klucze co lang/en.js (pilnuje tego test).
import en from "./lang/en.js";
import fr from "./lang/fr.js";
import de from "./lang/de.js";
import ru from "./lang/ru.js";

/** Dostępne języki: kod, flaga, nazwa własna, ustawienia regionalne dat, litery figur do promocji (h/q, w/r, g/b, s/n). */
export const LANGS = [
  { code: "pl", flag: "🇵🇱", name: "Polski", locale: "pl-PL", dict: null, promo: "hwgs" },
  { code: "en", flag: "🇬🇧", name: "English", locale: "en-GB", dict: en, promo: "qrbn" },
  { code: "fr", flag: "🇫🇷", name: "Français", locale: "fr-FR", dict: fr, promo: "dtfc" },
  { code: "de", flag: "🇩🇪", name: "Deutsch", locale: "de-DE", dict: de, promo: "dtls" },
  { code: "ru", flag: "🇷🇺", name: "Русский", locale: "ru-RU", dict: ru, promo: "флск" },
];

let cur = LANGS[0];
let DICT = {};

export const getLang = () => cur.code;
export const getLocale = () => cur.locale;
export const langInfo = () => cur;

export function setLang(code) {
  cur = LANGS.find((l) => l.code === code) || LANGS[0];
  DICT = cur.dict || {};
  if (typeof document !== "undefined") document.documentElement.lang = cur.code;
}

/** Język domyślny: pierwszy obsługiwany z ustawień urządzenia, w innych przypadkach angielski. */
export function defaultLang() {
  const langs = typeof navigator !== "undefined" ? navigator.languages || [navigator.language || ""] : [];
  for (const l of langs) {
    const code = (l || "").slice(0, 2).toLowerCase();
    if (LANGS.some((x) => x.code === code)) return code;
  }
  return "en";
}

/** Litera figury promocji (w dowolnym obsługiwanym języku) → q/r/b/n. */
export function promotionPiece(letter) {
  const c = (letter || "").toLowerCase();
  for (const l of LANGS) {
    const i = l.promo.indexOf(c);
    if (c && i >= 0) return "qrbn"[i];
  }
  return "q";
}

export function t(s, vars) {
  let out = Object.hasOwn(DICT, s) ? DICT[s] : s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  return out;
}

const ATTRS = ["placeholder", "title", "aria-label"];
const norm = (s) => s.replace(/\s+/g, " ").trim();

// Nazwy i komentarze użytkownika (oznaczone data-no-i18n) zostają bez zmian.
const isUserText = (node) => !!node.parentElement?.closest("[data-no-i18n]");

function translateText(node) {
  if (isUserText(node)) return;
  const key = norm(node.data);
  if (!key || !Object.hasOwn(DICT, key)) return;
  const lead = node.data.match(/^\s*/)[0];
  const trail = node.data.match(/\s*$/)[0];
  node.data = lead + DICT[key] + trail;
}

function translateElement(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v && Object.hasOwn(DICT, norm(v))) el.setAttribute(a, DICT[norm(v)]);
  }
}

function translateTree(root) {
  if (root.nodeType === 3) return translateText(root);
  if (root.nodeType !== 1) return;
  translateElement(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) translateText(n);
    else translateElement(n);
  }
}

/** Tłumaczy stronę i wszystko, co zostanie do niej dodane później. */
export function translateDom(root = document.body) {
  if (!cur.dict) return;
  translateTree(root);
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) translateTree(n);
  }).observe(root, { childList: true, subtree: true });
}

/** Przykładowy repertuar w języku interfejsu. */
export function samplePgn() {
  return `[Event "${t("Przykład: włoska")}"]
[Orientation "white"]

1. e4 e5 {${t("Najczęstsza odpowiedź.")}} (1... c5 2. Nf3 d6 (2... Nc6 3. d4) 3. d4) (1... e6 2. d4 d5 3. Nc3) 2. Nf3 Nc6 (2... d6 3. d4) 3. Bc4 {${t("Partia włoska.")}} Bc5 (3... Nf6 4. d3) 4. c3 Nf6 5. d3 *`;
}
