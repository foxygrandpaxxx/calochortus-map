/**
 * fetch-inat-data.js
 * Fetches all research-grade + needs_id Calochortus (mariposa lily) observations
 * from iNaturalist and writes compact JSON files consumed by the Calochortus Map.
 *
 * Run: node scripts/fetch-inat-data.js
 * Requires: INAT_API_TOKEN env var (from GitHub Secret or local .env)
 * Output:   inat/all.json, inat/{genus}.json, inat/fetch-report.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import parseGeoraster from 'georaster';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── Configuration ─────────────────────────────────────────────────────────────

const GENERA = [
  'Calochortus',
];

const QUALITY_GRADES  = ['research', 'needs_id'];
const MIN_YEAR        = 2006;   // iNat launched 2006; useful obs sparse before 2008
const MAX_YEAR        = new Date().getFullYear();
const RATE_LIMIT_MS   = 700;    // ~85 req/min — safe under iNat's 100/min limit
const MAX_RETRIES     = 3;
const MAX_PER_PAGE    = 200;
const CHUNK_THRESHOLD = 10000;  // recurse when count exceeds this

const API_BASE   = 'https://api.inaturalist.org/v1';
const USER_AGENT = 'CalochortusMap/1.0 (+https://github.com/foxygrandpaxxx/calochortus-map; monthly data refresh)';

// ── Species climate precompute config ─────────────────────────────────────────
const GRID_DEG        = 0.5;          // 0.5° cell ≈ 55 km north-south
const DENSE_RADIUS_KM = 8;            // neighbour radius for dense-cluster pick
const OM_RATE_MS      = 300;          // ~3 req/s — NASA POWER has no documented daily limit;
                                       // we pace conservatively as a good-citizen default
const OM_MIN_CELLS    = 1;            // include any species with ≥1 occupied cell;
                                       // the client flags small samples as low-confidence
const LAPSE_RATE      = 6.5 / 1000;  // °C per metre (standard environmental lapse)
// Climate source: NASA POWER (MERRA-2 reanalysis). Free, no auth, no per-IP
// daily cap. Returns daily T2M_MAX, T2M_MIN, PRECTOTCORR, and RH2M (daily mean)
// in one request. Switched from Open-Meteo's archive-api on 2026-05 after the
// 10k/day per-IP cap caused repeated bootstrap failures from both Azure (GH
// runners) and residential IPs.
const POWER_API       = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const ELEV_API        = 'https://api.opentopodata.org/v1/aster30m';  // ASTER 30m — covers 83°N–83°S (SRTM misses >60°N, losing Nordic/sub-arctic species)
const ELEV_RATE_MS    = 1_000;  // 1 s between batches — OpenTopoData allows 1 req/s
const ELEV_BACKOFF    = [5_000, 15_000, 30_000];  // retry delays on 429 / errors
const ELEV_CACHE_PATH = join(ROOT, 'inat', 'elev-cache.json');   // persisted across runs
const CLIM_CACHE_PATH = join(ROOT, 'inat', 'climate-cache.json'); // persisted across runs — avoids re-fetching 10k+ cells
const CLIM_CACHE_VER  = 3;   // bump when climate API source or cache shape changes to force re-fetch
                              // v1 = Open-Meteo ERA5 (deprecated)
                              // v2 = NASA POWER MERRA-2, monthly averages only
                              // v3 = NASA POWER MERRA-2 + per-cell monthly daily-extreme percentiles
                              //      (tempMaxHi p90 / tempMinLo p10) for species sidebar chart band

const MODE = process.argv[2] || 'all';  // 'obs' | 'species' | 'all'

// ── State ─────────────────────────────────────────────────────────────────────

let koppenRaster   = null;
let lastReqTime    = 0;
let totalRequests  = 0;
const startTime    = Date.now();
let omLastReq      = 0;             // Open-Meteo archive rate-limit state
let elevLastReq    = 0;             // OpenTopoData elevation rate-limit state

// ── Koppen lookup ─────────────────────────────────────────────────────────────

async function loadKoppenRaster() {
  const tifPath = join(ROOT, 'koppen_geiger_tif', '1991_2020', 'koppen_geiger_0p1.tif');
  const buf = readFileSync(tifPath);
  koppenRaster = await parseGeoraster(buf.buffer);
  console.log('✓ Koppen raster loaded (0.1° resolution)\n');
}

function getKoppen(lat, lng) {
  if (!koppenRaster) return 0;
  const { xmin, ymax, pixelWidth, pixelHeight, width, height, values } = koppenRaster;
  const col = Math.floor((lng - xmin) / pixelWidth);
  const row = Math.floor((ymax - lat) / pixelHeight);
  if (row < 0 || row >= height || col < 0 || col >= width) return 0;
  return values[0][row][col] || 0;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function rateLimitedFetch(url) {
  const wait = RATE_LIMIT_MS - (Date.now() - lastReqTime);
  if (wait > 0) await sleep(wait);
  lastReqTime = Date.now();
  totalRequests++;

  return fetch(url, {
    headers: {
      'Authorization': `Bearer ${process.env.INAT_API_TOKEN || ''}`,
      'Accept':        'application/json',
      'User-Agent':    USER_AGENT,
    }
  });
}

async function apiGet(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(String(k), String(v));
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await rateLimitedFetch(url.toString());

      if (res.ok) return res.json();

      if (res.status === 429) {
        console.warn(`    ⚠ Rate limited — waiting 60s (attempt ${attempt})`);
        await sleep(60_000);
        continue;
      }
      if (res.status >= 500) {
        console.warn(`    ⚠ Server error ${res.status} — retrying in ${attempt * 10}s`);
        await sleep(attempt * 10_000);
        continue;
      }
      throw new Error(`HTTP ${res.status} — ${url}`);

    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.warn(`    ⚠ Attempt ${attempt} failed: ${err.message} — retrying in ${attempt * 5}s`);
      await sleep(attempt * 5_000);
    }
  }
}

// ── Taxon ID resolution ───────────────────────────────────────────────────────

async function resolveTaxonId(genusName) {
  const data = await apiGet('/taxa', { q: genusName, rank: 'genus', is_active: true });
  const match = data.results.find(t => t.name === genusName && t.rank === 'genus');
  if (!match) throw new Error(`Could not resolve taxon_id for genus "${genusName}"`);
  return match.id;
}

// ── Recursive chunk fetcher ───────────────────────────────────────────────────
//
// Strategy:
//   1. Count-check first (1 request, fast)
//   2. If count ≤ CHUNK_THRESHOLD → paginate normally
//   3. If count > CHUNK_THRESHOLD and year set but not month → split by month
//   4. Otherwise bisect longitude, then latitude, recursively
//
// This guarantees we never attempt to fetch > 10k results in one query chain.

async function getCount(params) {
  const data = await apiGet('/observations', { ...params, per_page: 1, page: 1 });
  return data.total_results;
}

async function fetchAllPages(params, total) {
  const pages = Math.ceil(total / MAX_PER_PAGE);
  const results = [];
  for (let page = 1; page <= pages; page++) {
    const data = await apiGet('/observations', { ...params, per_page: MAX_PER_PAGE, page });
    results.push(...data.results);
    if (data.results.length === 0) break; // safety — shouldn't happen
  }
  return results;
}

async function fetchChunk(params, depth = 0) {
  const count = await getCount(params);
  if (count === 0) return [];

  if (count <= CHUNK_THRESHOLD) {
    return fetchAllPages(params, count);
  }

  const pad   = '  '.repeat(depth + 3);
  const loc   = params.year
    ? (params.month ? `${params.year}-${String(params.month).padStart(2,'0')}` : String(params.year))
    : 'all years';
  const bbox  = params.swlng != null
    ? ` bbox[${(+params.swlat).toFixed(1)},${(+params.swlng).toFixed(1)}→${(+params.nelat).toFixed(1)},${(+params.nelng).toFixed(1)}]`
    : '';
  console.log(`${pad}${count.toLocaleString()} > ${CHUNK_THRESHOLD} @ ${loc}${bbox} — splitting`);

  // Split 1: by month (if we have year but no month)
  if (params.year && !params.month) {
    const all = [];
    for (let m = 1; m <= 12; m++) {
      const sub = await fetchChunk({ ...params, month: m }, depth + 1);
      all.push(...sub);
    }
    return all;
  }

  // Split 2: bisect longitude
  const swlng = params.swlng != null ? +params.swlng : -180;
  const nelng = params.nelng != null ? +params.nelng :  180;
  const swlat = params.swlat != null ? +params.swlat :  -90;
  const nelat = params.nelat != null ? +params.nelat :   90;

  if (nelng - swlng > 0.5) {
    const mid = (swlng + nelng) / 2;
    const W   = await fetchChunk({ ...params, swlng, nelng: mid, swlat, nelat }, depth + 1);
    const E   = await fetchChunk({ ...params, swlng: mid, nelng, swlat, nelat }, depth + 1);
    return [...W, ...E];
  }

  // Split 3: bisect latitude
  if (nelat - swlat > 0.5) {
    const mid = (swlat + nelat) / 2;
    const S   = await fetchChunk({ ...params, swlng, nelng, swlat, nelat: mid }, depth + 1);
    const N   = await fetchChunk({ ...params, swlng, nelng, swlat: mid, nelat }, depth + 1);
    return [...S, ...N];
  }

  // Box too small to split further — fetch anyway (rare edge case)
  console.warn(`${pad}⚠ Cannot split further at ${swlat},${swlng}→${nelat},${nelng} (count=${count}). Fetching up to ${CHUNK_THRESHOLD}.`);
  return fetchAllPages(params, Math.min(count, CHUNK_THRESHOLD));
}

// ── Observation processor ─────────────────────────────────────────────────────
//
// Converts a raw iNat observation object into our compact 8-element array:
//   [obs_id, lat, lng, taxon_idx, date, flags, photo_id, koppen]
//
// flags bitfield:
//   bit 0: needs_id  (0=research_grade, 1=needs_id)
//   bit 1: obscured  (geoprivacy or taxon_geoprivacy = 'obscured')
//   bit 2: has_photo

function processObs(obs, taxaList, genus) {
  // iNat API v1 returns coordinates as a single "lat,lng" string in `location`
  // (no separate `latitude`/`longitude` fields). Private obs have location: null.
  const { id, observed_on, location, obscured, geoprivacy, taxon_geoprivacy,
          photos, quality_grade, taxon } = obs;

  if (!location) return null; // private/no-location obs

  const comma = location.indexOf(',');
  const lat = parseFloat(location.slice(0, comma));
  const lng = parseFloat(location.slice(comma + 1));
  if (isNaN(lat) || isNaN(lng)) return null;

  // Taxon info
  const taxonId     = taxon?.id      || 0;
  const taxonName   = taxon?.name    || genus;
  const commonName  = taxon?.preferred_common_name || null;

  // Find or create taxon in lookup table
  let ti = taxaList.findIndex(t => t[0] === taxonId);
  if (ti === -1) {
    taxaList.push([taxonId, taxonName, genus, commonName]);
    ti = taxaList.length - 1;
  }

  // Flags
  const isNeedsId  = quality_grade === 'needs_id' ? 1 : 0;
  // Use the top-level `obscured` boolean (most reliable); fall back to string checks
  const isObscured = (obscured || geoprivacy === 'obscured' || taxon_geoprivacy === 'obscured') ? 1 : 0;
  const hasPhoto   = photos?.length > 0 ? 1 : 0;
  const flags      = isNeedsId | (isObscured << 1) | (hasPhoto << 2);

  // First photo ID (reconstruct URL: https://inaturalist-open-data.s3.amazonaws.com/photos/{id}/square.jpeg)
  let photoId = 0;
  if (hasPhoto) {
    const m = photos[0].url?.match(/\/photos\/(\d+)\//);
    photoId = m ? parseInt(m[1]) : 0;
  }

  const koppen = getKoppen(lat, lng);
  const latR   = Math.round(lat * 10000) / 10000;
  const lngR   = Math.round(lng * 10000) / 10000;

  return [id, latR, lngR, ti, observed_on || '', flags, photoId, koppen];
}

// ── Per-genus fetch ───────────────────────────────────────────────────────────

async function fetchGenus(genus, taxonId) {
  const taxaList   = [];
  const obsAll     = [];
  const failedChunks = [];
  let   expectedTotal = 0;

  const baseParams = {
    taxon_id: taxonId,
    captive:  'false',
    order_by: 'id',
    order:    'asc',
  };

  for (const qg of QUALITY_GRADES) {
    const qgParams = { ...baseParams, quality_grade: qg };

    const total = await getCount(qgParams);
    console.log(`    ${qg}: ${total.toLocaleString()} observations`);
    expectedTotal += total;
    if (total === 0) continue;

    for (let year = MIN_YEAR; year <= MAX_YEAR; year++) {
      try {
        const raw = await fetchChunk({ ...qgParams, year });
        for (const obs of raw) {
          const processed = processObs(obs, taxaList, genus);
          if (processed) obsAll.push(processed);
        }
      } catch (err) {
        console.error(`    ✗ FAILED: ${genus} ${qg} ${year} — ${err.message}`);
        failedChunks.push({ genus, qg, year, error: err.message });
      }
    }
  }

  // Deduplicate by obs_id (first element) — geographic splits can produce overlaps
  const seen   = new Set();
  const deduped = obsAll.filter(o => {
    if (seen.has(o[0])) return false;
    seen.add(o[0]);
    return true;
  });

  const pct = expectedTotal ? Math.round(deduped.length / expectedTotal * 100) : 0;
  const warn = Math.abs(deduped.length - expectedTotal) / (expectedTotal || 1) > 0.02 ? ' ⚠ >2% gap' : '';
  console.log(`  → ${deduped.length.toLocaleString()} obs fetched (expected ~${expectedTotal.toLocaleString()}, ${pct}%)${warn}`);
  if (failedChunks.length) console.warn(`    ⚠ ${failedChunks.length} chunk(s) permanently failed`);

  return { taxa: taxaList, obs: deduped, expected: expectedTotal, failed: failedChunks };
}

// ── Species climate precomputation ───────────────────────────────────────────
//
// After all obs are collected we:
//   1. Assign every obs to a 0.5° global grid cell
//   2. Pick one representative GPS point per cell (densest local cluster)
//   3. Batch-fetch Copernicus GLO-30 elevations (OpenTopoData API, 100 per request)
//   4. Fetch climate normals per cell (Open-Meteo archive, temp+precip+RH combined)
//   5. Apply lapse-rate elevation correction to temperatures
//   6. For each taxon: aggregate p10/p25/p50/p75/p90 across its cells
//   7. Batch-fetch iNat taxa photos + Wikipedia summaries
//   8. Write inat/species-data.json

// ── Maths helpers ─────────────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R  = 6371;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pctile(sorted, p) {
  if (!sorted.length) return null;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const round1 = v => v == null ? null : Math.round(v * 10) / 10;
const round0 = v => v == null ? null : Math.round(v);

function computeStats(values, roundFn = round1) {
  const clean = values.filter(v => v != null && isFinite(v));
  if (!clean.length) return null;
  const s = [...clean].sort((a, b) => a - b);
  return {
    p10: roundFn(pctile(s, 10)),
    p25: roundFn(pctile(s, 25)),
    p50: roundFn(pctile(s, 50)),
    p75: roundFn(pctile(s, 75)),
    p90: roundFn(pctile(s, 90)),
  };
}

// ── Grid: build and select cell representatives ───────────────────────────────

/**
 * Groups all obs into 0.5° cells, then picks one representative per cell:
 * the point with the most neighbours within DENSE_RADIUS_KM (capped at 100
 * sample points per cell for speed). Returns Map<cellKey, {lat, lng}>.
 */
function buildGlobalGrid(allObs) {
  // Group obs coordinates by cell key
  const cells = new Map(); // cellKey → [{lat, lng}]
  for (const o of allObs) {
    const lat = o[1], lng = o[2];
    const key = `${Math.floor(lat / GRID_DEG)}:${Math.floor(lng / GRID_DEG)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ lat, lng });
  }

  // Select dense-cluster representative per cell
  const reps = new Map(); // cellKey → {lat, lng}
  for (const [key, pts] of cells) {
    if (pts.length === 1) { reps.set(key, pts[0]); continue; }

    // Subsample to ≤100 points before O(n²) density search
    const sample = pts.length > 100
      ? pts.filter((_, i) => i % Math.ceil(pts.length / 100) === 0)
      : pts;

    let bestPt = sample[0], bestCnt = -1;
    for (const pt of sample) {
      let cnt = 0;
      for (const other of sample) {
        if (haversineKm(pt.lat, pt.lng, other.lat, other.lng) <= DENSE_RADIUS_KM) cnt++;
      }
      if (cnt > bestCnt) { bestCnt = cnt; bestPt = pt; }
    }
    reps.set(key, bestPt);
  }

  console.log(`  Grid: ${reps.size.toLocaleString()} unique 0.5° cells`);
  return reps;
}

// ── Open-Meteo rate-limited fetch ─────────────────────────────────────────────

async function omGet(url) {
  const wait = OM_RATE_MS - (Date.now() - omLastReq);
  if (wait > 0) await sleep(wait);
  omLastReq = Date.now();
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } });
}

// ── Copernicus GLO-30 elevation batch fetch ───────────────────────────────────

async function elevGet(url) {
  const wait = ELEV_RATE_MS - (Date.now() - elevLastReq);
  if (wait > 0) await sleep(wait);
  elevLastReq = Date.now();
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } });
}

async function fetchElevations(cellReps) {
  const keys = [...cellReps.keys()];
  const BATCH = 100;

  // Load persisted cache (elevation data never changes for a fixed grid cell)
  let cache = {};
  if (existsSync(ELEV_CACHE_PATH)) {
    try {
      cache = JSON.parse(readFileSync(ELEV_CACHE_PATH, 'utf8'));
      console.log(`  Loaded ${Object.keys(cache).length.toLocaleString()} cached elevations`);
    } catch (err) {
      console.warn(`  ⚠ Could not read elevation cache: ${err.message}`);
    }
  }

  const missing = keys.filter(k => !(k in cache));  // null = cached no-data (ocean); undefined = never fetched

  if (missing.length === 0) {
    console.log(`  ✓ All ${keys.length.toLocaleString()} elevations served from cache — no API calls needed`);
    writeFileSync(ELEV_CACHE_PATH, JSON.stringify(cache)); // normalise / deduplicate
    return new Map(keys.map(k => [k, cache[k]]));
  }

  console.log(`  ${missing.length.toLocaleString()} cells need fetching (${keys.length - missing.length} cached)`);

  let fetched = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch     = missing.slice(i, i + BATCH);
    const coords    = batch.map(k => cellReps.get(k));
    // OpenTopoData uses pipe-separated "lat,lng" pairs
    const locations = coords.map(c => `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`).join('|');
    const url       = `${ELEV_API}?locations=${locations}`;

    let ok = false;
    for (let attempt = 0; attempt <= ELEV_BACKOFF.length; attempt++) {
      try {
        const res = await elevGet(url);
        if (res.ok) {
          const data = await res.json();
          // OpenTopoData returns { results: [{elevation, location}, ...], status: "OK" }
          if (data.results) {
            batch.forEach((key, j) => {
              const elev = data.results[j]?.elevation ?? null;  // null for ocean / no-data
              cache[key] = elev;
            });
            fetched += batch.length;
          }
          ok = true;
          break;
        }
        if (res.status === 429) {
          const delay = ELEV_BACKOFF[attempt] ?? ELEV_BACKOFF[ELEV_BACKOFF.length - 1];
          console.warn(`  ⚠ Elev 429 — waiting ${delay / 1000}s (attempt ${attempt + 1}/${ELEV_BACKOFF.length + 1})`);
          await sleep(delay);
        } else {
          console.warn(`  ⚠ Elev batch: HTTP ${res.status} — skipping`);
          break;
        }
      } catch (err) {
        console.warn(`  ⚠ Elev batch: ${err.message}`);
        if (attempt < ELEV_BACKOFF.length) await sleep(ELEV_BACKOFF[attempt]);
        else break;
      }
    }
    if (!ok) console.warn(`  ✗ Elev batch ${i}–${i + BATCH}: gave up after retries`);

    // Flush cache to disk every 1,000 cells so partial progress survives cancellation
    if ((i + BATCH) % 1000 === 0 || i + BATCH >= missing.length) {
      writeFileSync(ELEV_CACHE_PATH, JSON.stringify(cache));
    }
    if (i % 2000 === 0 && i > 0) {
      console.log(`  ${(i + BATCH).toLocaleString()}/${missing.length.toLocaleString()} missing cells processed`);
    }
  }

  console.log(`  ✓ ${fetched.toLocaleString()} new elevations fetched; cache total: ${Object.keys(cache).length.toLocaleString()}`);
  return new Map(keys.map(k => [k, cache[k] ?? null]));
}

// ── Climate fetch per cell ────────────────────────────────────────────────────

/**
 * Fetches 5-year (2019-2023) climate normals from NASA POWER (MERRA-2 reanalysis).
 * One request returns daily T_max, T_min, precip, and mean RH for the whole window.
 * Model elevation comes back in geometry.coordinates[2] (used for lapse-rate correction).
 *
 * Note: NASA POWER's /daily endpoint provides only daily-mean RH (RH2M), not
 * diurnal max/min. The old Open-Meteo path computed rhHigh/rhLow from hourly data,
 * but computeSpeciesData only reads rhMean, so the high/low values were unused.
 * We set rhHigh/rhLow to all-null in the cache to preserve schema shape.
 */
async function fetchCellClimate(lat, lng) {
  const url = `${POWER_API}?parameters=T2M_MAX,T2M_MIN,PRECTOTCORR,RH2M` +
    `&community=AG` +
    `&latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&start=20190101&end=20231231` +
    `&format=JSON`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await omGet(url);
      if (res.ok)           return parseClimateResponse(await res.json());
      if (res.status === 429) { await sleep(15_000); continue; }
      if (res.status >= 500)  { await sleep(attempt * 15_000); continue; }
      return null;
    } catch (err) {
      if (attempt === 3) return null;
      await sleep(attempt * 5_000);
    }
  }
  return null;
}

function parseClimateResponse(d) {
  const params = d?.properties?.parameter;
  if (!params || !params.T2M_MAX) return null;

  // NASA POWER returns [longitude, latitude, elevation_m] in geometry.coordinates.
  // Elevation is the MERRA-2 grid cell elevation — used for lapse-rate correction
  // against the actual ASTER 30m elevation at the observation site.
  const modelElev = d.geometry?.coordinates?.[2] ?? null;

  // POWER uses -999 as a sentinel for missing data (declared in header.fill_value).
  // We treat anything matching this (or any non-finite value) as missing.
  const FILL = -999;
  const isValid = v => v != null && v !== FILL && isFinite(v);

  // Per-month buckets of DAILY values (not just sums). We keep the full
  // distribution so we can compute extreme percentiles (p10 of daily mins,
  // p90 of daily maxes) for the species sidebar's chart band. Means come
  // from these buckets at the end. Precip/RH still use sum/count since we
  // only need monthly averages for those.
  const tmaxByMonth = Array.from({ length: 12 }, () => []);
  const tminByMonth = Array.from({ length: 12 }, () => []);
  const precSum = new Array(12).fill(0);
  const precYrs = Array.from({ length: 12 }, () => new Set());
  const rhSum   = new Array(12).fill(0), rhCnt   = new Array(12).fill(0);

  // POWER returns each parameter as an object keyed by date string "YYYYMMDD".
  // All four parameters share the same date keys, so we iterate T2M_MAX's keys
  // and look up the other three by the same key.
  for (const dateKey of Object.keys(params.T2M_MAX)) {
    const m = parseInt(dateKey.substring(4, 6), 10) - 1;  // "YYYYMMDD" → month (0-11)
    const y = dateKey.substring(0, 4);

    const tmax = params.T2M_MAX[dateKey];
    if (isValid(tmax)) tmaxByMonth[m].push(tmax);

    const tmin = params.T2M_MIN[dateKey];
    if (isValid(tmin)) tminByMonth[m].push(tmin);

    const p = params.PRECTOTCORR?.[dateKey];
    if (isValid(p)) { precSum[m] += p; precYrs[m].add(y); }

    const rh = params.RH2M?.[dateKey];
    if (isValid(rh)) { rhSum[m] += rh; rhCnt[m]++; }
  }

  // Inline percentile helper — linear-interpolated.
  const percentileOf = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const i = (p / 100) * (s.length - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  const meanOf = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return {
    modelElev,
    tempMax:   tmaxByMonth.map(meanOf),                       // monthly avg of daily max
    tempMin:   tminByMonth.map(meanOf),                       // monthly avg of daily min
    tempMaxHi: tmaxByMonth.map(a => percentileOf(a, 90)),     // NEW: p90 of daily max — typical hot extreme
    tempMinLo: tminByMonth.map(a => percentileOf(a, 10)),     // NEW: p10 of daily min — typical cold extreme
    precipMm:  precSum.map((s, m) => precYrs[m].size ? s / precYrs[m].size : null),
    // rhHigh/rhLow not available from POWER /daily endpoint. Kept as null arrays
    // for schema parity with v1 cache entries — computeSpeciesData only reads rhMean.
    rhHigh:    new Array(12).fill(null),
    rhLow:     new Array(12).fill(null),
    rhMean:    rhSum.map((s, m) => rhCnt[m] ? s / rhCnt[m] : null),
  };
}

// ── Lapse-rate elevation correction ──────────────────────────────────────────

/**
 * Humidity/temperature-aware lapse rate, °C per km. Blends the dry adiabatic
 * rate (~9.77, dry air cools fast) toward the moist adiabatic rate (~4–6, latent
 * heat slows cooling in humid air) by relative humidity. Mirrors the client's
 * lapseRateCkm() so observation/click panels and species envelopes use the same
 * physics. A physically-motivated proxy, clamped to [4, 9.8].
 */
function lapseRateCkm(tempC, rhPct, elevM) {
  const g = 9.81, cpd = 1004.6, Hv = 2.501e6, Rsd = 287.05, eps = 0.622;
  const T  = tempC + 273.15;
  const P  = 1013.25 * Math.pow(1 - 2.25577e-5 * (elevM || 0), 5.25588);
  const es = 6.112 * Math.exp(17.67 * tempC / (tempC + 243.5));
  const rs = eps * es / Math.max(P - es, 1e-3);
  const gMoist = g * (1 + Hv * rs / (Rsd * T)) /
                 (cpd + Hv * Hv * rs * eps / (Rsd * T * T)) * 1000;
  const gDry = g / cpd * 1000;
  const rh = Math.max(0, Math.min(100, rhPct == null ? 55 : rhPct));
  return Math.max(4.0, Math.min(9.8, gDry - (gDry - gMoist) * (rh / 100)));
}

/**
 * Adjusts all temperature fields for the elevation difference between the
 * climate-model grid (modelElev) and the cell's representative ground elevation
 * (elev), using a per-month humidity-aware lapse rate (see lapseRateCkm). Precip
 * and RH are left unchanged.
 */
function applyLapseRate(climate, elev) {
  if (elev == null || climate.modelElev == null) return climate;
  const dzKm = (elev - climate.modelElev) / 1000;   // +ve → ground higher → colder
  const corr = (field) => Array.isArray(climate[field])
    ? climate[field].map((v, m) => {
        if (v == null) return null;
        const meanT = (climate.tempMax?.[m] != null && climate.tempMin?.[m] != null)
          ? (climate.tempMax[m] + climate.tempMin[m]) / 2 : v;
        const rate = lapseRateCkm(meanT, climate.rhMean?.[m], climate.modelElev);
        return round1(v - rate * dzKm);
      })
    : (climate[field] ?? null);
  return {
    ...climate,
    tempMax:   corr('tempMax'),
    tempMin:   corr('tempMin'),
    tempMaxHi: corr('tempMaxHi'),
    tempMinLo: corr('tempMinLo'),
  };
}

// ── iNat taxa info batch fetch ────────────────────────────────────────────────

async function fetchInatTaxaInfo(taxaToFetch) {
  // taxaToFetch: [{ti, taxonId}]
  const info  = new Map(); // ti → {photo_url, wikipedia_summary, inat_url}
  const BATCH = 30;

  for (let i = 0; i < taxaToFetch.length; i += BATCH) {
    const batch = taxaToFetch.slice(i, i + BATCH);
    const ids   = batch.map(t => t.taxonId).join(',');
    try {
      const data = await apiGet('/taxa', { id: ids, per_page: BATCH });
      if (data?.results) {
        for (const t of data.results) {
          const match = batch.find(b => b.taxonId === t.id);
          if (match) {
            info.set(match.ti, {
              photo_url:         t.default_photo?.medium_url || t.default_photo?.square_url || null,
              wikipedia_summary: t.wikipedia_summary || null,
              inat_url:          `https://www.inaturalist.org/taxa/${t.id}`,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`  ⚠ taxa-info batch ${i}–${i + BATCH}: ${err.message}`);
    }
    if ((i / BATCH + 1) % 10 === 0) {
      console.log(`  ${Math.min(i + BATCH, taxaToFetch.length)}/${taxaToFetch.length} taxa info fetched`);
    }
  }

  return info;
}

// ── iNat phenology (blooming period) histograms ───────────────────────────────
// iNaturalist's "Flowers and Fruits" annotation (controlled term 12) drives the
// seasonality chart on a species page. We fetch the month-of-year histogram for
// each phenology value, wild-only (captive=false), split by hemisphere so the
// austral / boreal seasons don't smear together. One request per (value ×
// occupied hemisphere); single-hemisphere species cost 3 requests, dual cost 6.
const PHENO_TERM = 12;
const PHENO_VALUES = {            // output key → controlled-term value id
  flowering: 13,                 // "Flowers"
  budding:   15,                 // "Flower Buds"
  fruiting:  14,                 // "Fruits or Seeds"
};
const PHENO_HEMIS = {
  nh: { swlat: 0,   swlng: -180, nelat: 90, nelng: 180 },
  sh: { swlat: -90, swlng: -180, nelat: 0,  nelng: 180 },
};

async function phenoHistogram(taxonId, valueId, hemi) {
  try {
    const data = await apiGet('/observations/histogram', {
      taxon_id: taxonId,
      term_id: PHENO_TERM,
      term_value_id: valueId,
      interval: 'month_of_year',
      captive: false,
      verifiable: true,
      ...PHENO_HEMIS[hemi],
    });
    const h = data?.results?.month_of_year;
    if (!h) return null;
    const arr = Array.from({ length: 12 }, (_, m) => h[String(m + 1)] || 0);
    return arr.some(v => v > 0) ? arr : null;   // drop empty series
  } catch {
    return null;
  }
}

async function fetchPhenology(taxaToFetch) {
  const out = new Map();   // ti → { flowering:{nh,sh}, budding:{...}, fruiting:{...} }
  let done = 0;
  for (const { ti, taxonId, hasNH, hasSH } of taxaToFetch) {
    const hemis = [];
    if (hasNH) hemis.push('nh');
    if (hasSH) hemis.push('sh');
    const ph = {};
    for (const [key, valueId] of Object.entries(PHENO_VALUES)) {
      const byHemi = {};
      for (const hemi of hemis) {
        const arr = await phenoHistogram(taxonId, valueId, hemi);
        if (arr) byHemi[hemi] = arr;
      }
      if (Object.keys(byHemi).length) ph[key] = byHemi;
    }
    if (Object.keys(ph).length) out.set(ti, ph);
    if (++done % 50 === 0) console.log(`  ${done}/${taxaToFetch.length} phenology fetched`);
  }
  return out;
}

// ── Main species precompute orchestrator ──────────────────────────────────────

async function computeSpeciesData(allTaxa, allObs) {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Species Climate Precomputation                  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ── 1. Build global 0.5° grid ─────────────────────────────────────────────
  console.log('▶ Building global 0.5° grid...');
  const cellReps = buildGlobalGrid(allObs);

  // ── 2. Copernicus GLO-30 elevations ──────────────────────────────────────
  console.log('\n▶ Fetching Copernicus GLO-30 elevations (batched 100/request)...');
  const elevs = await fetchElevations(cellReps);
  const elevHits = [...elevs.values()].filter(v => v != null).length;
  console.log(`  ✓ ${elevHits.toLocaleString()}/${elevs.size.toLocaleString()} elevations resolved (${elevs.size - elevHits} null/ocean)`);

  // ── 3. Climate per cell ───────────────────────────────────────────────────
  const cellKeys = [...cellReps.keys()];

  // Load persisted climate cache. Cache versioning is now PER-CELL FIELD-AWARE
  // rather than file-version-gated: v2 entries (NASA POWER, monthly averages
  // only) are kept and incrementally upgraded by re-fetching them to add the
  // v3 daily-extreme fields (tempMaxHi, tempMinLo). Failed fetches don't
  // overwrite existing entries, so partial upgrades are safe — you can re-run
  // any number of times to make progress without losing existing data.
  //
  // Only v1 (Open-Meteo ERA5, deprecated source) is fully discarded — its
  // schema is incompatible with the current NASA POWER pipeline.
  let climCache = {};
  if (existsSync(CLIM_CACHE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CLIM_CACHE_PATH, 'utf8'));
      if (raw._v === CLIM_CACHE_VER || raw._v === 2) {
        climCache = raw;
        const cellCount = Object.keys(climCache).filter(k => k !== '_v').length;
        const note = raw._v < CLIM_CACHE_VER
          ? ` — will upgrade per-cell to v${CLIM_CACHE_VER} as fetches complete`
          : '';
        console.log(`  Loaded ${cellCount.toLocaleString()} cached cell climates (v${raw._v})${note}`);
      } else {
        console.log(`  Old climate cache version (${raw._v ?? 'none'} → ${CLIM_CACHE_VER}) — incompatible schema, clearing for re-fetch`);
      }
    } catch (err) {
      console.warn(`  ⚠ Could not read climate cache: ${err.message}`);
    }
  }

  // A cell needs fetching if it's MISSING from the cache OR it's present but
  // missing v3 daily-extreme fields. The latter means it's a v2 entry that
  // hasn't been upgraded yet. The fetch produces a complete v3 entry that
  // replaces the v2 entry in-memory (existing fields are recomputed identically
  // from the same daily POWER data, so no information is lost).
  const missingClim = cellKeys.filter(k => {
    const cell = climCache[k];
    if (!cell) return true;                              // never fetched
    if (!Array.isArray(cell.tempMaxHi)) return true;     // v2 entry, needs upgrade
    if (!Array.isArray(cell.tempMinLo)) return true;
    return false;
  });
  // ~1s/request from NASA POWER + 300ms rate-limit gap ≈ 1.3s per cell
  const estMin = Math.round(missingClim.length * 1300 / 60_000);
  // Renamed to avoid shadowing the cacheTotal declared after the fetch loop
  // (which counts cells AFTER fetches complete, not before).
  const cacheStart = Object.keys(climCache).filter(k => k !== '_v').length;
  const v3Already = cacheStart - missingClim.length;
  console.log(`\n▶ Fetching climate data for ${cellKeys.length.toLocaleString()} cells (${missingClim.length.toLocaleString()} need fetch, ${v3Already.toLocaleString()} already v3, ~${estMin} min)...`);

  let omFetched = 0, omFailed = 0;

  for (const key of missingClim) {
    const { lat, lng } = cellReps.get(key);
    const raw = await fetchCellClimate(lat, lng);
    if (raw) {
      climCache[key] = raw;
      omFetched++;
    } else {
      omFailed++;
    }
    const done = omFetched + omFailed;
    if (done % 500 === 0) {
      const pct = Math.round(done / missingClim.length * 100);
      console.log(`  [${pct}%] ${done.toLocaleString()}/${missingClim.length.toLocaleString()} (${omFailed} failed)`);
    }
    // Flush every 100 cells so partial progress survives a timeout or cancellation
    if (done % 100 === 0) {
      climCache._v = CLIM_CACHE_VER;
      writeFileSync(CLIM_CACHE_PATH, JSON.stringify(climCache));
    }
  }
  if (missingClim.length > 0) {
    climCache._v = CLIM_CACHE_VER;
    writeFileSync(CLIM_CACHE_PATH, JSON.stringify(climCache)); // final flush
  }
  const cacheTotal = Object.keys(climCache).filter(k => k !== '_v').length;
  console.log(`  ✓ ${omFetched.toLocaleString()} new climates fetched, ${omFailed} failed; cache total: ${cacheTotal.toLocaleString()}\n`);

  // Build cellClimates map with lapse-rate correction applied from cached raw data
  const cellClimates = new Map(); // cellKey → lapse-rate-corrected climate object
  for (const key of cellKeys) {
    const raw = climCache[key];
    if (raw) {
      const elev = elevs.get(key) ?? null;
      cellClimates.set(key, applyLapseRate(raw, elev));
    }
  }

  // ── 4. Build per-taxon indices ────────────────────────────────────────────
  console.log('▶ Building species indices...');
  const taxonCells    = new Map(); // taxonIdx → Set<cellKey>
  const taxonKoppen   = new Map(); // taxonIdx → Map<zone, count>
  const taxonObsCount = new Map(); // taxonIdx → count

  for (const o of allObs) {
    const ti   = o[3];
    const lat  = o[1], lng = o[2];
    const zone = o[7];
    const key  = `${Math.floor(lat / GRID_DEG)}:${Math.floor(lng / GRID_DEG)}`;

    if (!taxonCells.has(ti))  taxonCells.set(ti, new Set());
    taxonCells.get(ti).add(key);

    if (!taxonKoppen.has(ti)) taxonKoppen.set(ti, new Map());
    if (zone > 0) {
      const m = taxonKoppen.get(ti);
      m.set(zone, (m.get(zone) || 0) + 1);
    }

    taxonObsCount.set(ti, (taxonObsCount.get(ti) || 0) + 1);
  }

  // ── 5. Compute per-taxon stats ────────────────────────────────────────────
  console.log('▶ Computing species climate envelopes...');
  const speciesData  = {};
  const taxaToFetch  = [];

  for (let ti = 0; ti < allTaxa.length; ti++) {
    const cells = taxonCells.get(ti);
    if (!cells || cells.size < OM_MIN_CELLS) continue;

    // Gather climate objects for this taxon's occupied cells
    const climates = []; // [{c: climate, lat, lng, elev}]
    for (const key of cells) {
      const c = cellClimates.get(key);
      const r = cellReps.get(key);
      if (c && r) climates.push({ c, lat: r.lat, lng: r.lng, elev: elevs.get(key) ?? null });
    }
    if (climates.length < OM_MIN_CELLS) continue;

    const [taxonId, taxonName, genus, commonName] = allTaxa[ti];

    // Annual headline metrics (one value per sample point)
    const annualMaxT  = [], annualMinT  = [], annualPrec = [], annualRH = [];
    for (const { c } of climates) {
      const maxT  = c.tempMax.filter(v => v != null);
      const minT  = c.tempMin.filter(v => v != null);
      const prec  = c.precipMm.filter(v => v != null);
      const rh    = c.rhMean.filter(v => v != null);
      if (maxT.length) annualMaxT.push(Math.max(...maxT));
      if (minT.length) annualMinT.push(Math.min(...minT));
      if (prec.length) annualPrec.push(prec.reduce((a, b) => a + b, 0));
      if (rh.length)   annualRH.push(rh.reduce((a, b) => a + b, 0) / rh.length);
    }

    // Monthly chart data: split NH (lat ≥ 0) and SH (lat < 0)
    const nhC = climates.filter(({ lat }) => lat >= 0).map(({ c }) => c);
    const shC = climates.filter(({ lat }) => lat <  0).map(({ c }) => c);

    // For each hemisphere, compute per-month [p25, p50, p75] for each metric
    const monthlyPct = (arr, field) => {
      if (!arr.length) return null;
      return Array.from({ length: 12 }, (_, m) => {
        const vals = arr.map(c => c[field]?.[m]).filter(v => v != null);
        if (!vals.length) return null;
        const s = [...vals].sort((a, b) => a - b);
        return [round1(pctile(s, 25)), round1(pctile(s, 50)), round1(pctile(s, 75))];
      });
    };

    // Per-month median (across cells) of a per-cell array field. Used for the
    // extreme-temperature band on the species sidebar chart — represents
    // "the typical hot/cold extreme experienced by cells where this species
    // occurs". Returns 12 scalar values (not [p25,p50,p75]) — the band only
    // needs one high and one low line per month.
    const monthlyMedian = (arr, field) => {
      if (!arr.length) return null;
      return Array.from({ length: 12 }, (_, m) => {
        const vals = arr.map(c => c[field]?.[m]).filter(v => v != null);
        if (!vals.length) return null;
        const s = [...vals].sort((a, b) => a - b);
        return round1(pctile(s, 50));
      });
    };

    const makeMonthly = arr => arr.length ? {
      tempMax:   monthlyPct(arr, 'tempMax'),
      tempMin:   monthlyPct(arr, 'tempMin'),
      // NEW: median (across cells) of each cell's per-month p90 daily-high
      // and p10 daily-low. These drive the extreme-range band on the chart —
      // shows "what extremes the species actually deals with in its native
      // range" beyond the within-cell-month-average envelope above.
      tempMaxHi: monthlyMedian(arr, 'tempMaxHi'),
      tempMinLo: monthlyMedian(arr, 'tempMinLo'),
      precip:    monthlyPct(arr, 'precipMm'),
      rh:        monthlyPct(arr, 'rhMean'),
    } : null;

    // Köppen zone distribution sorted by count
    const koppenMap = taxonKoppen.get(ti) || new Map();
    const koppen    = [...koppenMap.entries()].sort((a, b) => b[1] - a[1]);

    // ── Daily-extreme temperature tiers (aligned with the obs/click panels) ──
    // Per cell: avg high/low = hottest/coldest month's MEAN; hot/cold extreme =
    // hottest month's p90 daily high / coldest month's p10 daily low. Then:
    //   Avg High/Low          = mean across cells (the typical site)
    //   Typical Hot/Cold Ext  = mean across cells of the per-cell extreme
    //   Heat/Cold Limit       = p90 / p10 across cells of the per-cell extreme
    //                           (the hot/cold edge of the tolerated range; p10/p90
    //                           trims one bad cell without dropping real extremes)
    const perCell = climates.map(({ c }) => {
      const maxA = c.tempMax.filter(v => v != null);
      const minA = c.tempMin.filter(v => v != null);
      const hiA  = (c.tempMaxHi || []).filter(v => v != null);
      const loA  = (c.tempMinLo || []).filter(v => v != null);
      return {
        avgHigh: maxA.length ? Math.max(...maxA) : null,
        avgLow:  minA.length ? Math.min(...minA) : null,
        hotExt:  hiA.length  ? Math.max(...hiA)  : null,
        coldExt: loA.length  ? Math.min(...loA)  : null,
      };
    });
    const meanAcross = vals => {
      const v = vals.filter(x => x != null);
      return v.length ? round1(v.reduce((a, b) => a + b, 0) / v.length) : null;
    };
    const pctAcross = (vals, p) => {
      const v = vals.filter(x => x != null).sort((a, b) => a - b);
      return v.length ? round1(pctile(v, p)) : null;
    };
    const tempTiers = {
      avgHigh:     meanAcross(perCell.map(x => x.avgHigh)),
      avgLow:      meanAcross(perCell.map(x => x.avgLow)),
      hotTypical:  meanAcross(perCell.map(x => x.hotExt)),
      coldTypical: meanAcross(perCell.map(x => x.coldExt)),
      hotLimit:    pctAcross(perCell.map(x => x.hotExt), 90),
      coldLimit:   pctAcross(perCell.map(x => x.coldExt), 10),
    };

    // Elevation range across occupied cells (representative-point elevations).
    const elevVals = climates.map(c => c.elev).filter(v => v != null).sort((a, b) => a - b);
    const elevStats = elevVals.length ? {
      min:    Math.round(elevVals[0]),
      max:    Math.round(elevVals[elevVals.length - 1]),
      p10:    Math.round(pctile(elevVals, 10)),
      p90:    Math.round(pctile(elevVals, 90)),
      median: Math.round(pctile(elevVals, 50)),
    } : null;

    speciesData[taxonId] = {
      taxon_id:        taxonId,
      scientific_name: taxonName,
      common_name:     commonName || null,
      genus,
      obs_count:       taxonObsCount.get(ti) || 0,
      sample_count:    climates.length,
      stats: {
        // Legacy annual mean-based percentiles (kept for back-compat).
        tempMax: computeStats(annualMaxT, round1),
        tempMin: computeStats(annualMinT, round1),
        precip:  computeStats(annualPrec, round0),
        rhMean:  computeStats(annualRH,   round0),
        // Daily-extreme tiers + elevation range (v4).
        ...tempTiers,
        elev: elevStats,
      },
      monthly_nh: makeMonthly(nhC),
      monthly_sh: makeMonthly(shC),
      koppen,
      // photo_url, wikipedia_summary, inat_url added in step 6
    };

    taxaToFetch.push({ ti, taxonId, hasNH: nhC.length > 0, hasSH: shC.length > 0 });
  }

  console.log(`  ✓ ${Object.keys(speciesData).length} species with ≥${OM_MIN_CELLS} cells\n`);

  // ── 6. iNat taxa photos + Wikipedia ──────────────────────────────────────
  console.log(`▶ Fetching iNat taxa info for ${taxaToFetch.length} species...`);
  const taxaInfo = await fetchInatTaxaInfo(taxaToFetch);
  for (const { ti, taxonId } of taxaToFetch) {
    const info = taxaInfo.get(ti);
    if (info && speciesData[taxonId]) Object.assign(speciesData[taxonId], info);
  }
  console.log(`  ✓ ${taxaInfo.size} taxa with photo/Wikipedia data\n`);

  // ── 6b. iNat phenology (flowering / budding / fruiting) histograms ────────
  console.log(`▶ Fetching iNat phenology histograms for ${taxaToFetch.length} species...`);
  const phenology = await fetchPhenology(taxaToFetch);
  for (const { ti, taxonId } of taxaToFetch) {
    const ph = phenology.get(ti);
    if (ph && speciesData[taxonId]) speciesData[taxonId].phenology = ph;
  }
  console.log(`  ✓ ${phenology.size} taxa with phenology data\n`);

  // ── 7. Write output ───────────────────────────────────────────────────────
  const output = {
    v:              1,
    generated:      new Date().toISOString(),
    cell_count:     cellClimates.size,
    species_count:  Object.keys(speciesData).length,
    species:        speciesData,
  };

  writeFileSync(join(ROOT, 'inat', 'species-data.json'), JSON.stringify(output));
  console.log(`✓ Written inat/species-data.json\n`);

  return output;
}

// ── Species-only mode (reads inat/all.json written by obs job) ────────────────

async function runSpeciesMode() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Bogman iNat Species Climate Precompute          ║');
  console.log(`║  ${new Date().toISOString()}              ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  const allPath = join(ROOT, 'inat', 'all.json');
  if (!existsSync(allPath)) {
    throw new Error('inat/all.json not found — run "node fetch-inat-data.js obs" first');
  }

  console.log('▶ Loading observation data from inat/all.json...');
  const { taxa: allTaxa, obs: allObs } = JSON.parse(readFileSync(allPath, 'utf8'));
  console.log(`  ${allObs.length.toLocaleString()} observations, ${allTaxa.length.toLocaleString()} taxa\n`);

  await loadKoppenRaster();
  mkdirSync(join(ROOT, 'inat'), { recursive: true });

  const speciesResult = await computeSpeciesData(allTaxa, allObs);

  const report = {
    generated:     new Date().toISOString(),
    obs_loaded:    allObs.length,
    taxa_loaded:   allTaxa.length,
    species_count: speciesResult.species_count,
    cell_count:    speciesResult.cell_count,
    durationMin:   Math.round((Date.now() - startTime) / 60000),
  };
  writeFileSync(join(ROOT, 'inat', 'species-report.json'), JSON.stringify(report, null, 2));

  const mins = report.durationMin;
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Summary                                         ║');
  console.log(`║  Obs loaded         : ${String(allObs.length.toLocaleString()).padEnd(27)}║`);
  console.log(`║  Species w/ data    : ${String(speciesResult.species_count.toLocaleString()).padEnd(27)}║`);
  console.log(`║  Climate cells      : ${String(speciesResult.cell_count.toLocaleString()).padEnd(27)}║`);
  console.log(`║  Duration           : ${String(mins + ' min').padEnd(27)}║`);
  console.log('╚══════════════════════════════════════════════════╝');
}

// ── Obs fetch mode (and legacy all-in-one mode) ───────────────────────────────

async function main() {
  if (MODE === 'species') {
    await runSpeciesMode();
    return;
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Calochortus iNat Data Fetch                     ║');
  console.log(`║  ${new Date().toISOString()}              ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!process.env.INAT_API_TOKEN) {
    console.warn('⚠ INAT_API_TOKEN not set — requests will be unauthenticated (rate limits apply)\n');
  }

  await loadKoppenRaster();
  mkdirSync(join(ROOT, 'inat'), { recursive: true });

  // Resolve taxon IDs for all genera
  console.log('Resolving iNat taxon IDs...');
  const generaResolved = [];
  for (const genus of GENERA) {
    try {
      const taxonId = await resolveTaxonId(genus);
      console.log(`  ${genus.padEnd(14)} taxon_id = ${taxonId}`);
      generaResolved.push({ name: genus, taxonId });
    } catch (err) {
      console.error(`  ✗ ${genus}: ${err.message}`);
    }
  }
  console.log('');

  // Fetch each genus
  const allTaxa = [];
  const allObs  = [];
  const report  = { generated: new Date().toISOString(), genera: {}, totalRequests: 0, totalObs: 0 };

  for (const genus of generaResolved) {
    console.log(`▶ ${genus.name}`);
    const result = await fetchGenus(genus.name, genus.taxonId);

    // Write per-genus file (taxon indices local to this file)
    const genusOut = { v: 1, generated: new Date().toISOString(), genus: genus.name, taxa: result.taxa, obs: result.obs };
    writeFileSync(join(ROOT, 'inat', `${genus.name.toLowerCase()}.json`), JSON.stringify(genusOut));

    // Merge into combined dataset (remap taxon indices to global offset)
    const idxOffset = allTaxa.length;
    allTaxa.push(...result.taxa);
    for (const o of result.obs) {
      allObs.push([o[0], o[1], o[2], o[3] + idxOffset, o[4], o[5], o[6], o[7]]);
    }

    report.genera[genus.name] = { fetched: result.obs.length, expected: result.expected, failed: result.failed };
    console.log('');
  }

  // Write combined file (read by the species job)
  writeFileSync(join(ROOT, 'inat', 'all.json'), JSON.stringify({ v: 1, generated: new Date().toISOString(), taxa: allTaxa, obs: allObs }));

  if (MODE === 'all') {
    // Legacy single-job mode: also run species precompute inline
    const speciesResult = await computeSpeciesData(allTaxa, allObs);
    report.speciesCount = speciesResult.species_count;
    report.cellCount    = speciesResult.cell_count;
  }

  // Write fetch report
  report.totalRequests = totalRequests;
  report.totalObs      = allObs.length;
  report.durationMin   = Math.round((Date.now() - startTime) / 60000);
  writeFileSync(join(ROOT, 'inat', 'fetch-report.json'), JSON.stringify(report, null, 2));

  // Summary
  const mins = report.durationMin;
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Summary                                         ║');
  console.log(`║  Total observations : ${String(allObs.length.toLocaleString()).padEnd(27)}║`);
  if (report.speciesCount != null) {
    console.log(`║  Species w/ data    : ${String(report.speciesCount.toLocaleString()).padEnd(27)}║`);
    console.log(`║  Climate cells      : ${String(report.cellCount.toLocaleString()).padEnd(27)}║`);
  }
  console.log(`║  API requests       : ${String(totalRequests.toLocaleString()).padEnd(27)}║`);
  console.log(`║  Duration           : ${String(mins + ' min').padEnd(27)}║`);

  const failures = Object.values(report.genera).flatMap(g => g.failed);
  if (failures.length) {
    console.log(`║  ⚠ Failed chunks    : ${String(failures.length).padEnd(27)}║`);
  }
  console.log('╚══════════════════════════════════════════════════╝');

  if (failures.length) {
    console.log('\nFailed chunks (re-run manually if needed):');
    failures.forEach(f => console.log(`  ${f.genus} ${f.qg} ${f.year}: ${f.error}`));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
