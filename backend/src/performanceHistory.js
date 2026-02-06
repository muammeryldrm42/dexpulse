const fs = require("fs");
const path = require("path");

const PERF_HISTORY_PATH = process.env.PERF_HISTORY_PATH || "/var/data/performance_history.json";

const SOURCE_ALIASES = {
  smart_money: ["Smart Money"],
  whale: ["Whale Alert"],
  hot_buys: ["Hot Buys"],
  signal_plus: ["Signal+"]
};

function normalizeSource(source){
  const raw = String(source || "").trim();
  const lower = raw.toLowerCase();
  if (lower === "smart money" || lower === "smart_money") return "smart_money";
  if (lower === "whale alert" || lower === "whale") return "whale";
  if (lower === "hot buys" || lower === "hot_buys") return "hot_buys";
  if (lower === "signal+" || lower === "signal_plus") return "signal_plus";
  return raw;
}

function findEntry(address, source){
  const addr = String(address || "");
  const normalized = normalizeSource(source);
  const canonicalKey = `${addr}:${normalized}`;
  if (history.entries[canonicalKey]){
    return { entry: history.entries[canonicalKey], key: canonicalKey, normalized };
  }
  const aliases = SOURCE_ALIASES[normalized] || [];
  for (const alias of aliases){
    const legacyKey = `${addr}:${alias}`;
    if (history.entries[legacyKey]){
      return { entry: history.entries[legacyKey], key: legacyKey, normalized };
    }
  }
  return { entry: null, key: canonicalKey, normalized };
}

function loadJsonFile(filePath, fallback){
  try{
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  }catch(_){
    return fallback;
  }
  return fallback;
}

const history = loadJsonFile(PERF_HISTORY_PATH, { entries: {} });
let saveTimer = null;

function scheduleSave(){
  if (saveTimer) return;
  saveTimer = setTimeout(()=>{
    saveTimer = null;
    try{
      fs.mkdirSync(path.dirname(PERF_HISTORY_PATH), { recursive: true });
      fs.writeFileSync(PERF_HISTORY_PATH, JSON.stringify(history, null, 2));
    }catch(_){
      // ignore
    }
  }, 1500);
}

function computeRoi(entry){
  const entryMc = Number(entry.entryMc || 0);
  const peakMc = Number(entry.peakMc || 0);
  if (entryMc > 0 && peakMc > 0){
    const roiX = peakMc / entryMc;
    entry.roiX = Number.isFinite(roiX) ? Number(roiX.toFixed(2)) : 0;
    const roiPct = (roiX - 1) * 100;
    entry.roiPct = Number.isFinite(roiPct) ? Number(roiPct.toFixed(2)) : 0;
  }else{
    entry.roiX = 0;
    entry.roiPct = 0;
  }
}

function recordBuySignal({ address, source, ident, mc }){
  const addr = String(address || "");
  const src = normalizeSource(source);
  const entryMc = Number(mc || 0);
  if (!addr || !src || entryMc <= 0) return;

  const key = `${addr}:${src}`;
  const now = Date.now();
  const found = findEntry(addr, src);
  let existing = found.entry;

  if (existing && found.key !== key){
    delete history.entries[found.key];
    existing.id = key;
    existing.source = src;
    history.entries[key] = existing;
  }

  if (!existing){
    const entry = {
      id: key,
      address: addr,
      source: src,
      name: ident?.name || "Token",
      symbol: ident?.symbol || "",
      logo: ident?.logo || "",
      signal: "BUY",
      entryMc,
      peakMc: entryMc,
      lastMc: entryMc,
      roiPct: 0,
      roiX: 1,
      status: "active",
      notes: "",
      firstSeen: now,
      lastSeen: now
    };
    computeRoi(entry);
    history.entries[key] = entry;
    scheduleSave();
    return;
  }

  existing.lastSeen = now;
  existing.name = ident?.name || existing.name;
  existing.symbol = ident?.symbol || existing.symbol;
  existing.logo = ident?.logo || existing.logo;
  existing.signal = "BUY";
  existing.source = src || existing.source;
  if (!existing.entryMc || existing.entryMc <= 0){
    existing.entryMc = entryMc;
  }
  existing.lastMc = entryMc;
  existing.peakMc = Math.max(Number(existing.peakMc || 0), entryMc);
  computeRoi(existing);
  scheduleSave();
}

function updatePeak(address, mc){
  const addr = String(address || "");
  const curMc = Number(mc || 0);
  if (!addr || curMc <= 0) return;
  let changed = false;

  Object.values(history.entries).forEach(entry => {
    if (entry.address !== addr) return;
    entry.lastSeen = Date.now();
    entry.lastMc = curMc;
    if (!entry.signal && Number(entry.entryMc || 0) > 0) entry.signal = "BUY";
    if (curMc > Number(entry.peakMc || 0)){
      entry.peakMc = curMc;
      if (entry.status === "removed" && entry.notes && !entry.notes.includes("Peak updated after removal")){
        entry.notes = `${entry.notes} Peak updated after removal.`.trim();
      }
      computeRoi(entry);
      changed = true;
    }else{
      changed = true;
    }
  });

  if (changed) scheduleSave();
}

function markRemoved(address, reason){
  const addr = String(address || "");
  if (!addr) return;
  const note = reason ? `Removed due to ${reason.replaceAll("_", " ")}.` : "Removed.";
  let changed = false;

  Object.values(history.entries).forEach(entry => {
    if (entry.address !== addr) return;
    if (entry.status !== "removed"){
      entry.status = "removed";
      entry.notes = entry.notes ? `${entry.notes} ${note}` : note;
      entry.lastSeen = Date.now();
      changed = true;
    }
  });

  if (changed) scheduleSave();
}

function listEntries(){
  return Object.values(history.entries)
    .map(entry => {
      if (!entry.signal && Number(entry.entryMc || 0) > 0) entry.signal = "BUY";
      return entry;
    })
    .sort((a,b)=> (b.lastSeen || 0) - (a.lastSeen || 0));
}

module.exports = {
  recordBuySignal,
  getEntry: (address, source) => findEntry(address, source).entry,
  updatePeak,
  markRemoved,
  listEntries,
  PERF_HISTORY_PATH
};
