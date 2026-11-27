# SpotiStats

Statystyki słuchania Spotify w stylu stats.fm, liczone z **pełnego eksportu historii** — w całości w przeglądarce. Nic nie jest wysyłane na serwer; dane zostają w IndexedDB tej przeglądarki.

**Strona:** https://bartoszkrop.github.io/SpotiStats2.0/ (GitHub Pages z gałęzi `main`)

## Co potrafi

- **Zakresy:** 7 dni, 28 dni, pół roku, wybrany rok kalendarzowy, cały czas.
  7/28 dni i pół roku liczone są wstecz od **ostatniego odsłuchu w danych** (eksport bywa sprzed kilku tygodni, więc „od dziś” dawałoby pusto).
- **Top 10** wykonawców, utworów i albumów — sortowanie wg czasu albo wg liczby odtworzeń.
- **Top 10 w czasie** — wykres liniowy minut słuchania (dni / tygodnie / miesiące) dla top 10 wykonawców albo utworów z wybranego zakresu; legenda pozwala włączać i wyłączać linie.
- **Nr 1 tygodnia** — kto był najczęściej słuchanym wykonawcą w każdym tygodniu (albo miesiącu), wykres pozycji w rankingu i licznik tygodni na szczycie.
- **5 kont** — Ty + 4 znajomych (limit Spotify dla prywatnych aplikacji). Każde konto ma osobny eksport w przeglądarce i osobny automat.
- **Wykonawca w czasie** — wykres dowolnego wykonawcy (wyszukiwarka albo klik w topce), cały czas lub wybrany zakres, do tego jego najczęściej słuchane utwory.
- **Karta wykonawcy** — klik w dowolnego wykonawcę (topka, utwór, rekord) otwiera jego kartę na wierzchu; gest/przycisk „wstecz” ją zamyka.
- Na telefonie: okresy w dolnym pasku pod kciukiem, top wykonawcy jako przesuwana karuzela, utwory/albumy w zakładkach, opcje konta (zapis na GitHubie, nowszy eksport, automat) w menu „⋯”.
- Podcasty, audiobooki i wpisy bez wykonawcy są **pomijane**. Duplikaty z nakładających się plików są usuwane.
- „Odtworzenie” liczy się od 30 s słuchania (jak w stats.fm); minuty liczą się zawsze.

## Automatyczne dociąganie nowych odsłuchów

Jak w stats.fm: eksport wczytujesz raz, a nowe odsłuchy dociągają się same.

- Workflow `.github/workflows/spotify-sync.yml` co godzinę pyta Spotify o 50 ostatnich utworów każdego podłączonego konta (`/me/player/recently-played`) i dopisuje nowe do `konta/<n>/odsluchy/<rok>.json` na gałęzi **`dane`** (publicznej, jak profil stats.fm). Spis kont: `konta.json`.
- Znajomego dodajesz: developer.spotify.com → Twoja aplikacja → User Management, potem wysyłasz mu link `spotify.html?konto=<n>`, a kod, który odeśle, wklejasz w **Run workflow** z wybranym kontem.
- Strona przy otwarciu pobiera te pliki i dokłada odsłuchy **nowsze niż koniec eksportu**, więc nic się nie dubluje. Świeży eksport zawsze ma pierwszeństwo.
- Refresh token leży na gałęzi `dane` zaszyfrowany (AES-256-GCM) kluczem z sekretu `SPOTIFY_CLIENT_SECRET`.
- API nie mówi, ile utworu faktycznie słuchano (zwraca tylko te grane ≥30 s), więc przyjmowana jest jego pełna długość.
- Spotify unieważnia logowanie po ok. 6 miesiącach — strona pokaże baner i trzeba zalogować się ponownie.

Konfiguracja krok po kroku jest na podstronie **`spotify.html`** (link „⟳ Automat” w górnym pasku). W skrócie: aplikacja na developer.spotify.com (wymaga Premium), dwa sekrety w repo (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`), logowanie na `spotify.html` i przekazanie kodu do workflow przez **Run workflow**.

## Jak zdobyć dane

1. spotify.com → Konto → **Prywatność** → zaznacz **„Rozszerzona historia strumieniowania”** (Extended streaming history) → poproś o dane.
2. Po kilku dniach przyjdzie mail z plikiem `my_spotify_data.zip`.
3. Otwórz stronę i wrzuć ten `.zip` w całości (albo pliki `Streaming_History_Audio_*.json`).

Działa też krótki eksport „Dane konta” (`StreamingHistory_music_*.json`, tylko ostatni rok). Jeśli wrzucisz oba, krótki jest ignorowany, żeby nic się nie zdublowało.

## Uruchomienie lokalnie

Bez builda i bez zależności. Wystarczy otworzyć `index.html` w przeglądarce (działa też z `file://`) albo:

```bash
python3 -m http.server 8080   # potem http://localhost:8080
```

## Testy

```bash
node --test
```

## Pliki

| Plik | Co robi |
|------|---------|
| `index.html`, `styles.css` | strona |
| `app.js` | import, zapis w IndexedDB, renderowanie |
| `analytics.js` | czyste funkcje: normalizacja, zakresy, topki, osie czasu |
| `charts.js` | wykres liniowy w SVG |
| `jszip.min.js` | odczyt .zip (lokalnie, bez CDN) |
| `live.js` | odczyt dociągniętych odsłuchów z gałęzi `dane` |
| `spotify.html` | jednorazowe połączenie automatu ze Spotify |
| `scripts/spotify-sync.mjs` | skrypt automatu (GitHub Actions) |

## Dalsze pomysły

Porównanie ze znajomym (dwa eksporty obok siebie), ranking z przesunięciami pozycji, rozkład po godzinach i dniach tygodnia.
