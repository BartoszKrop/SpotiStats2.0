# SpotiStats

Statystyki słuchania Spotify w stylu stats.fm, liczone z **pełnego eksportu historii** — w całości w przeglądarce. Nic nie jest wysyłane na serwer; dane zostają w IndexedDB tej przeglądarki.

**Strona:** https://bartoszkrop.github.io/SpotiStats2.0/ (GitHub Pages z gałęzi `main`)

## Co potrafi

- **Zakresy:** 7 dni, 28 dni, pół roku, wybrany rok kalendarzowy, cały czas.
  7/28 dni i pół roku liczone są wstecz od **ostatniego odsłuchu w eksporcie** (eksport bywa sprzed kilku tygodni, więc „od dziś” dawałoby pusto).
- **Top 10** wykonawców, utworów i albumów — sortowanie wg czasu albo wg liczby odtworzeń.
- **Top 10 w czasie** — wykres liniowy minut słuchania (dni / tygodnie / miesiące) dla top 10 wykonawców albo utworów z wybranego zakresu; legenda pozwala włączać i wyłączać linie.
- **Wykonawca w czasie** — wykres dowolnego wykonawcy (wyszukiwarka albo klik w topce), cały czas lub wybrany zakres, do tego jego najczęściej słuchane utwory.
- Podcasty, audiobooki i wpisy bez wykonawcy są **pomijane**. Duplikaty z nakładających się plików są usuwane.
- „Odtworzenie” liczy się od 30 s słuchania (jak w stats.fm); minuty liczą się zawsze.

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

## Dalsze pomysły

Porównanie ze znajomym (dwa eksporty obok siebie), ranking z przesunięciami pozycji, rozkład po godzinach i dniach tygodnia.
