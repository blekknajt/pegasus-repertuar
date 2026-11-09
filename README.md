# Repertuar Pegasus

Trening repertuaru debiutowego z powtórkami (spaced repetition) na fizycznej szachownicy
**DGT Pegasus** przez Web Bluetooth — działa w Chrome na Androidzie.

- import PGN (z wariantami) i studiów Lichess,
- ruchy przeciwnika podświetlane diodami, Twoje ruchy rozpoznawane z czujników,
- tryb bez planszy (ruchy na ekranie), statystyki, praca offline.

Dane zostają w przeglądarce urządzenia (IndexedDB). Oceny silnika i odpowiedzi bazy partii
są tam również zapamiętywane — raz odwiedzona pozycja działa potem bez sieci.

Protokół planszy: nieoficjalny opis https://dgtcentaurmods.github.io/pegasus-protocol.
Biblioteki: [chess.js](https://github.com/jhlywa/chess.js) (BSD-2), figury „cburnett” z Lichess (CC BY-SA 3.0, Colin M.L. Burnett),
[Stockfish.js](https://github.com/nmrugg/stockfish.js) 17.1 lite (GPLv3, licencja w `lib/stockfish/Copying.txt`; źródła: https://github.com/official-stockfish/Stockfish).
Ocena z chmury: https://lichess.org/api#tag/Analysis.

Testy: `node --test tests/core.test.mjs`. Sprawdzają import wariantów, transpozycje,
odczyt planszy po ponownym połączeniu i poprawność kopii zapasowej. Jeśli obok
repozytorium są prywatne eksporty Chessbooka, test obejmie je również; pliki PGN
nie są publikowane.
