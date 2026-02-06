const fs = require("fs");
const path = require("path");

const PERF_HISTORY_PATH = process.env.PERF_HISTORY_PATH || "/var/data/performance_history.json";

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
  const src = String(source || "");
  const entryMc = Number(mc || 0);
  if (!addr || !src || entryMc <= 0) return;

  const key = `${addr}:${src}`;
  const now = Date.now();
  const existing = history.entries[key];

  if (!existing){
    const entry = {
      id: key,
      address: addr,
      source: src,
      name: ident?.name || "Token",
      symbol: ident?.symbol || "",
      logo: ident?.logo || "",
      entryMc,
      peakMc: entryMc,
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
  if (!existing.entryMc || existing.entryMc <= 0){
    existing.entryMc = entryMc;
  }
  if (entryMc > Number(existing.peakMc || 0)){
    existing.peakMc = entryMc;
  }
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
    if (curMc > Number(entry.peakMc || 0)){
      entry.peakMc = curMc;
      entry.lastSeen = Date.now();
      if (entry.status === "removed" && entry.notes && !entry.notes.includes("Peak updated after removal")){
        entry.notes = `${entry.notes} Peak updated after removal.`.trim();
      }
      computeRoi(entry);
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
  return Object.values(history.entries).sort((a,b)=> (b.lastSeen || 0) - (a.lastSeen || 0));
}

module.exports = {
  recordBuySignal,
  updatePeak,
  markRemoved,
  listEntries,
  PERF_HISTORY_PATH
};
