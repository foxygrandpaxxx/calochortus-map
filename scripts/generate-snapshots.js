/**
 * generate-snapshots.js
 *
 * Playwright script that generates a PNG snapshot of the climate map for each
 * mapped taxon. Snapshots are saved to ../snapshots/{slug}.png at 600×420px.
 *
 * Usage (future):
 *   node scripts/generate-snapshots.js
 *
 * Each snapshot opens the map in embed mode:
 *   map.html?taxon={taxon.id}&embed=true
 *
 * The embed mode renders a compact non-interactive view with:
 *   - Map zoomed to the taxon's pin location
 *   - Climate summary card below the map
 *   - No controls or side panel
 *
 * Prerequisites (future):
 *   npm install playwright
 *   npx playwright install chromium
 *
 * The script will:
 *   1. Fetch data.json from the gallery repo to get the taxon list
 *   2. Filter to taxa that have mapPin.lat / mapPin.lng
 *   3. For each taxon, open map.html?taxon={id}&embed=true in a headless browser
 *   4. Wait for the map and climate card to render
 *   5. Screenshot at 600×420px and save to snapshots/{slug}.png
 *   6. Commit the snapshots folder to the repo
 *
 * NOT YET IMPLEMENTED — placeholder only.
 */
