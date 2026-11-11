# Repertuar Pegasus

**[Polski](#polski) · [English](#english)**

Aplikacja: **https://blekknajt.github.io/pegasus-repertuar/**

---

## Polski

Trening repertuaru debiutowego z powtórkami (spaced repetition) na fizycznej szachownicy
**DGT Pegasus** przez Web Bluetooth — działa w Chrome na Androidzie. Można też ćwiczyć
bez planszy, wykonując ruchy na ekranie.

### Co potrafi

- import PGN (z wariantami) i studiów Lichess, edytor repertuaru z komentarzami,
- nauka nowych ruchów i powtórki w odstępach (SRS), statystyki i najsłabsze ruchy,
- ruchy przeciwnika podświetlane diodami, Twoje ruchy rozpoznawane z czujników planszy,
- analiza w trakcie treningu: Stockfish (chmura Lichess albo lokalnie), baza partii Lichess
  i mistrzów, próbne ruchy na ekranie lub na planszy bez wpływu na powtórki,
- pauza po linii (nigdy / po błędzie / zawsze), żeby spokojnie przeanalizować pomyłkę,
- **fokusy** — ćwiczenie wycinka repertuaru od wybranej pozycji (np. tylko przyjęty gambit
  Smith-Morra): powtórki, nowe ruchy albo przegląd całości; postępy są wspólne z całym repertuarem,
- praca offline (PWA), kopia zapasowa do pliku,
- interfejs po polsku i angielsku (przełącznik flagą w górnym pasku).

Dane zostają w przeglądarce urządzenia (IndexedDB). Oceny silnika i odpowiedzi bazy partii
są tam również zapamiętywane — raz odwiedzona pozycja działa potem bez sieci.

### Dla programistów

Testy: `node --test tests/*.test.mjs`. Sprawdzają import wariantów, transpozycje, fokusy,
odczyt planszy po ponownym połączeniu, próbne ruchy i pauzę w treningu oraz poprawność kopii
zapasowej. Jeśli obok repozytorium są prywatne eksporty Chessbooka, test obejmie je również;
pliki PGN nie są publikowane.

Lokalnie: `python3 -m http.server 8765` w tym katalogu i `http://127.0.0.1:8765/`.

---

## English

Opening repertoire trainer with spaced repetition for the physical **DGT Pegasus** chessboard,
connected over Web Bluetooth — works in Chrome on Android. You can also train without the
board by making moves on the screen.

> The app is available in English and Polish — switch the language with the flag in the top bar.

### Features

- import PGN (with variations) and Lichess studies, repertoire editor with comments,
- learning new moves and spaced-repetition reviews (SRS), statistics and weakest moves,
- opponent moves shown with the board's LEDs, your moves detected from the board's sensors,
- analysis during training: Stockfish (Lichess cloud eval or local engine), Lichess and masters
  opening database, trial moves on screen or on the board that don't affect your reviews,
- pause after a line (never / after a mistake / always), so you can analyse what went wrong,
- **focuses** — train just one part of a repertoire from a chosen position (e.g. only the
  accepted Smith-Morra Gambit): reviews, new moves or a full drill; progress is shared with
  the whole repertoire,
- works offline (PWA), backup to a file.

All data stays in the browser on your device (IndexedDB). Engine evaluations and opening
database answers are cached there too — a position you've visited once works offline later.

### For developers

Tests: `node --test tests/*.test.mjs`. They cover importing variations, transpositions,
focuses, reading the board after reconnecting, trial moves and the pause during training,
and backup validation. If private Chessbook exports sit next to the repository, the test
covers them too; those PGN files are not published.

Locally: `python3 -m http.server 8765` in this directory, then open `http://127.0.0.1:8765/`.

---

## Credits / Licencje

Protokół planszy / board protocol: unofficial description https://dgtcentaurmods.github.io/pegasus-protocol.
Biblioteki / libraries: [chess.js](https://github.com/jhlywa/chess.js) (BSD-2), „cburnett” pieces from Lichess (CC BY-SA 3.0, Colin M.L. Burnett),
[Stockfish.js](https://github.com/nmrugg/stockfish.js) 17.1 lite (GPLv3, license in `lib/stockfish/Copying.txt`; sources: https://github.com/official-stockfish/Stockfish).
Ocena z chmury / cloud eval: https://lichess.org/api#tag/Analysis.

---

☕ Jeśli aplikacja Ci się przydaje — [postaw mi kawę](https://buycoffee.to/klafciarz).
If you find the app useful — [buy me a coffee](https://buycoffee.to/klafciarz).
