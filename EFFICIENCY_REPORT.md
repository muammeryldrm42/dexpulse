# DexPulse Efficiency Report

Below are several places in the codebase where performance could be improved.

---

## 1. `pickBestPair` sorts entire array to find a single max element

**File:** `backend/src/app.js`, lines 327-336

```js
function pickBestPair(pairs){
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const score = (p) => { ... };
  return [...pairs].sort((a,b)=>score(b)-score(a))[0];
}
```

**Issue:** Copies and sorts the full array (O(n log n)) just to pick the top element. A single-pass O(n) scan is sufficient and avoids the array copy.

**Impact:** Called on every token lookup (`tokenPairs` -> `pickBestPair`), so this runs hundreds of times per request cycle during `boostedSeed`, `getAllSignals`, search, etc.

**Fix:** Replace with a `reduce`-style linear scan. *(Fixed in this PR.)*

---

## 2. `buildPerformanceSummary` re-scans entries per source

**File:** `backend/src/app.js`, lines 682-689

```js
for (const [src, stats] of Object.entries(bySource)){
  const srcEntries = entries.filter(e => String(e.source || "unknown") === src);
  const srcRoi = srcEntries.reduce(...);
  const srcWins = srcEntries.filter(...).length;
  ...
}
```

**Issue:** After already looping over all entries once (lines 662-680), it re-filters the full list for every unique source. That turns an O(n) aggregation into O(n * s) where s = number of sources.

**Fix:** Accumulate `roiSum`, `roiCount`, and `wins` per source in the first pass and compute averages afterward in a single loop.

---

## 3. `boostedSeed` fetches token pairs sequentially

**File:** `backend/src/app.js`, lines 934-959

```js
for (const x of base){
  ...
  const pairs = await tokenPairs(addr);
  ...
}
```

**Issue:** Each `tokenPairs` call is an HTTP request to the DexScreener API, awaited one at a time. Other parts of the codebase (e.g., `/api/list/majors`, `/api/list/okx_wallet_signal`) already use `mapLimit` to run up to 4 requests concurrently.

**Fix:** Refactor `boostedSeed` to use `mapLimit` (already defined in the codebase) for concurrent fetching, with a concurrency limit of 4.

---

## 4. Dynamic `import()` of `node-fetch` on every fetch call

**File:** `backend/src/app.js`, line 6

```js
global.fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
```

**Issue:** Every call to `global.fetch` triggers a dynamic `import()`. Although Node.js caches ESM imports after the first load, the promise chain and module resolution still add overhead per call.

**Fix:** Import `node-fetch` once at the top with `require` (the project already uses CommonJS and has `node-fetch@2` which supports `require`).

---

## 5. Redundant risk/dump recomputation inside `isTrash` and `computeSmartMoney`

**File:** `backend/src/app.js`

- `isTrash` (lines 760-769) recomputes `computeRisk` and `computeDumpRisk` even when the caller already has those values (e.g., `buildSignalPlusList` at line 1063 has `x.risk`).
- `computeSmartMoney` (line 449) internally calls `computeRisk`, `computeWhaleLike`, and `computeDumpRisk`, even though `boostedSeed` (line 950-953) already computed all three for the same pair.

**Fix:** Accept pre-computed risk/dump/whale objects as optional parameters so callers can pass cached results.

---

## 6. No eviction for expired cache entries

**File:** `backend/src/app.js`, lines 12-23

```js
const cache = new Map();
function getCached(key){
  const hit = cache.get(key);
  if (!hit) return null;
  if (now() > hit.exp) return null;   // expired but never deleted
  return hit.val;
}
```

**Issue:** Expired entries remain in the Map forever. Over time, this causes unbounded memory growth proportional to the number of unique URLs fetched.

**Fix:** Delete expired entries in `getCached` when detected (`cache.delete(key)`) and/or add a periodic sweep.
