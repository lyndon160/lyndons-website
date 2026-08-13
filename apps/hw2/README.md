# Halo Wars 2 observed-corpus dashboard

This standalone static app publishes a privacy-safe snapshot of the local Halo
Wars 2 ranked-match analysis. The HTML contains aggregate data only: it makes no
network requests and includes no API key, XUID, gamertag, or raw event payload.

The published page is a snapshot. Updating the local crawler database does not
change production until a freshly generated `dashboard.html` replaces
`src/index.html` and the app is redeployed.

## Development

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run check
npm run build
python3 -m http.server 8000 --directory dist
```

Open <http://localhost:8000> to inspect the production build.

## Updating the snapshot

Generate and validate the dashboard in the HW2 analytics project, then copy the
result into `src/index.html`. Preserve the production canonical, social, and
favicon metadata in the document head before building.

## Netlify

- Repository: `lyndon160/lyndons-website`
- Production branch: `master`
- Base directory: `apps/hw2`
- Package directory: unset
- Build command: `npm run build`
- Publish directory: `dist`
- Canonical hostname: `https://hw2.lyndonfawcett.com`

The nested `netlify.toml` owns the build, Node runtime, response headers,
caching, and single-page fallback. The root Hugo site and its Netlify project
are intentionally unaffected.
