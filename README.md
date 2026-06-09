# Calochortus Climate Map

Interactive map of *Calochortus* (mariposa, globe, and star lilies) built from real
iNaturalist observations, with a Köppen-Geiger climate overlay and per-species /
per-location climate data.

A **static, single-file web app** (`map.html`) plots precomputed iNaturalist
observations on a Leaflet map and shows per-location, per-observation, and
per-species **climate + elevation** estimates. A **Node script run by GitHub
Actions** does all the heavy data fetching monthly and commits compact JSON back
to the repo, which the app reads at load. No backend, no database.

---

## How It Works

- **Observations** — research-grade + needs-ID *Calochortus* observations are
  fetched from the [iNaturalist API](https://www.inaturalist.org/) and stored as
  compact positional arrays in `inat/`.
- **Climate** — per 0.5° grid cell, daily temperature / precipitation / humidity
  normals from [NASA POWER](https://power.larc.nasa.gov/) (MERRA-2), elevation-
  corrected with a humidity-aware lapse rate.
- **Köppen overlay** — the Köppen-Geiger raster in `koppen_geiger_tif/` is sampled
  client-side for the colored climate-zone overlay and per-point lookups.
- **Single file** — all CSS + JS live inline in `map.html`. No build step.

---

## Repo Structure

```
calochortus-map/
├── map.html                  ← the entire front-end app (HTML + CSS + JS)
├── inat/                     ← precomputed data, committed by the workflow
│   ├── all.json              ← every observation
│   ├── calochortus.json      ← per-genus observations
│   ├── species-data.json     ← per-species climate envelopes + phenology + elevation
│   ├── climate-cache.json    ← per-cell raw climate (avoids re-fetching)
│   └── elev-cache.json       ← per-cell elevations
├── scripts/
│   └── fetch-inat-data.js    ← the data pipeline (Node ESM)
├── koppen_geiger_tif/        ← Köppen raster (sampled client-side)
└── .github/workflows/
    ├── fetch-inat-data.yml   ← monthly cron: obs refresh + species climate
    └── test-inat-token.yml   ← manual: verify the iNat API token secret
```

---

## Data Pipeline

The data is fetched by `scripts/fetch-inat-data.js` (run by GitHub Actions):

```
node scripts/fetch-inat-data.js obs       # fetch all observations → inat/*.json
node scripts/fetch-inat-data.js species   # precompute species climate envelopes
```

`.github/workflows/fetch-inat-data.yml` runs both monthly (and on manual
dispatch), committing the refreshed `inat/*` files back to `main`.

### iNat API token (required for the workflow)

The fetch authenticates to iNaturalist with a personal API token:

1. Sign in at iNaturalist and copy a token from
   <https://www.inaturalist.org/users/api_token>.
2. In this repo: **Settings → Secrets and variables → Actions → New repository
   secret**, name it `INAT_API_TOKEN`, paste the token.
3. Run the **Test iNat API Token** workflow (Actions tab) to confirm it works,
   then run **Refresh iNat Data** to populate `inat/`.

> Tokens expire periodically — re-run the test workflow if a fetch starts failing
> with 401, and refresh the secret.

---

## Hosting / Embedding

GitHub Pages on `main`, or embed via jsDelivr:

```html
<iframe
  src="https://cdn.jsdelivr.net/gh/foxygrandpaxxx/calochortus-map@main/map.html"
  style="width:100%;height:calc(100vh - 80px);border:none;display:block;">
</iframe>
```

---

## Deep Linking

Shareable URL parameters (set automatically as you navigate):

```
?sp=<taxonId>        → open a species sidebar
?obs=<obsId>         → open a single observation
?at=lat,lng,zoom     → open a clicked location's climate panel
?region=<admin>      → apply an administrative-region filter
```
