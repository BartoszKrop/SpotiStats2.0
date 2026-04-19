# stats.fm-like feature parity checklist

## 1) Core stats
- [x] Top artists
- [x] Top tracks
- [x] Top albums
- [x] Top genres
- [x] Streams count
- [x] Listening time (hours/minutes)
- [x] Full history timeline (with filters)
- [x] Day-by-day listening analysis

## 2) Real-time listening
- [ ] Live now-playing stream
- [ ] Real-time session updates
- [ ] Session tracking
- [ ] Dynamic real-time rankings

## 3) Scrobbling / import
- [x] Full history import from Spotify export JSON
- [ ] Automatic new plays synchronization from Spotify API
- [x] Detailed log (when/track/artist/album/time)
- [x] History filters (date range, artist, album, track)

## 4) Rankings and charts
- [x] Listening trends over time (daily chart)
- [x] Activity heatmaps (weekday/hour)
- [ ] Weekly/monthly ranking snapshots
- [ ] Ranking position deltas (gainers/decliners)

## 5) Comparisons
- [ ] Compare two users
- [ ] Who listens more
- [ ] Top overlap / shared tracks
- [ ] Taste differences

## 6) Insights / discovery
- [ ] Audio DNA profile
- [ ] Recommendation layer based on history
- [ ] Dominant genres analysis (advanced)
- [ ] Similar artists
- [ ] Taste evolution timeline

## 7) Playlists and integrations
- [ ] Export top lists to Spotify playlists
- [ ] Auto-generated monthly/yearly playlists
- [x] Spotify account connection (OAuth MVP)
- [ ] Quick add-to-playlist actions

## 8) User profile
- [ ] Public profile
- [ ] Avatar/bio
- [ ] Share links / image cards
- [ ] Flex cards for social

## 9) PRO scope
- [ ] Unlimited deep history UX
- [ ] Advanced filters and charts
- [ ] Unlimited custom ranges
- [ ] Advanced comparisons
- [ ] Data export presets

## 10) Time filters
- [x] All time
- [x] Last 4 weeks
- [x] Last 6 months
- [x] Last year
- [x] Custom range

## 11) Visual/UI
- [x] Dark mode (inherited from Streamlit theme)
- [ ] Light mode toggle
- [ ] Widgets/cards for home view
- [ ] Animated rank transitions

## 12) Technical integrations
- [x] Spotify API OAuth foundation (PKCE)
- [x] Historical file import
- [ ] Background sync worker
- [x] Cached computations for faster reloads
