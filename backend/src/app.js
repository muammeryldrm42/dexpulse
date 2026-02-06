const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const perfHistory = require("./performanceHistory");
global.fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const cache = new Map();
function now(){ return Date.now(); }
function getCached(key){
  const hit = cache.get(key);
  if (!hit) return null;
  if (now() > hit.exp) return null;
  return hit.val;
}
function setCached(key, val, ttlMs){
  cache.set(key, { val, exp: now() + ttlMs });
  return val;
}

// Persistent veto blacklist based on market-cap crashes and dump/rug-like behavior.
// Rule: if MC collapses ~10x (e.g., 100k -> 10k), blacklist permanently.
// Additional rule: auto-remove on fast ~70% MC dumps or rug-like liquidity wipes.
const mcSeen = new Map(); // address -> { mc, liq, ts }
const VETO_PATH = process.env.VETO_PATH || "/var/data/veto_blacklist.json";
const vetoStore = loadJsonFile(VETO_PATH, { items: {} });
let vetoSaveTimer = null;

// Smart-money continuity tracker (avoid one-tick spikes).
const smartSeen = new Map(); // address -> { streak, lastScore, ts }

async function fetchJson(url, ttlMs = 15000){
  const cached = getCached(url);
  if (cached) return cached;
  const res = await fetch(url, { headers: { "accept": "application/json", "user-agent":"dexPulse-v6" } });
  if (!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error(`Upstream ${res.status}: ${t.slice(0,200)}`);
  }
  const data = await res.json();
  return setCached(url, data, ttlMs);
}

// --- Token classification helpers
const STABLE_SYMBOLS = new Set([
  "USDC","USDT","DAI","UXD","USDH","PYUSD","USDP","FRAX","TUSD","USDJ"
]);

// Liquid staking / staked SOL wrappers to keep out of Majors list
const LST_SYMBOLS = new Set([
  "MSOL",
  "JITOSOL",
  "JUPSOL",
  "BSOL",
  "SCNSOL",
  "HUBSOL",
  "INF",
  "SOLBLZE",
  "LST"
]);

function isStableSymbol(sym){
  const s = String(sym || "").toUpperCase();
  return STABLE_SYMBOLS.has(s);
}

function isLSTSymbol(sym){
  const s = String(sym || "").toUpperCase();
  return LST_SYMBOLS.has(s);
}

function safeNum(x){
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function isMcBlacklisted(address){
  return Boolean(vetoStore.items[String(address||"")]);
}

function setMcBlacklist(address, reason, meta){
  const addr = String(address||"");
  if (!addr) return;
  if (vetoStore.items[addr]) return;
  vetoStore.items[addr] = { ts: now(), reason, ...meta };
  perfHistory.markRemoved(addr, reason);
  scheduleVetoSave();
  console.log(`[veto] ${addr} ${reason}`);
}

function scheduleVetoSave(){
  if (vetoSaveTimer) return;
  vetoSaveTimer = setTimeout(()=>{
    vetoSaveTimer = null;
    try{
      fs.mkdirSync(path.dirname(VETO_PATH), { recursive: true });
      fs.writeFileSync(VETO_PATH, JSON.stringify(vetoStore, null, 2));
    }catch(_){}
  }, 1500);
}

function loadJsonFile(filePath, fallback){
  try{
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  }catch(_){}
  return fallback;
}

function updateMcCrash(address, bestPair){
  const addr = String(address||"");
  if (!addr || !bestPair) return false;
  if (isMcBlacklisted(addr)) return true;
  const curMc = safeNum(bestPair?.marketCap);
  const curLiq = safeNum(bestPair?.liquidity?.usd);
  const prev = mcSeen.get(addr);
  let reason = "";
  if (prev && prev.mc > 0 && curMc > 0){
    // 10x collapse rule, with a small floor to reduce noise.
    if (curMc <= (prev.mc / 10) && prev.mc >= 20000){
      reason = "mc_crash";
    }else if ((now() - prev.ts) <= 60 * 60 * 1000 && curMc <= (prev.mc * 0.3) && prev.mc >= 20000){
      reason = "fast_dump";
    }else if (prev.liq >= 5000 && curLiq > 0 && curLiq <= (prev.liq * 0.2) && curMc <= (prev.mc * 0.3)){
      reason = "rug_like";
    }
  }
  // Track latest observation.
  if (curMc > 0 || curLiq > 0) mcSeen.set(addr, { mc: curMc, liq: curLiq, ts: now() });
  if (reason){
    setMcBlacklist(addr, reason, { prevMc: prev?.mc || 0, mc: curMc, prevLiq: prev?.liq || 0, liq: curLiq });
    return true;
  }
  return false;
}

function passesQualityGate(bestPair, allowHighRisk = false){
  if (!bestPair) return false;
  if (isTrash(bestPair)) return false;
  if (allowHighRisk) return true;
  const risk = computeRisk(bestPair);
  return risk.riskLabel !== "HIGH";
}

function trackBuySignals(items, source){
  for (const item of items){
    if (!item?.showBuy) continue;
    const mc = item?.bestPair?.marketCap;
    perfHistory.recordBuySignal({ address: item.address, source, ident: item.ident, mc });
  }
}

function updatePeaks(items){
  for (const item of items){
    const mc = item?.bestPair?.marketCap;
    perfHistory.updatePeak(item.address, mc);
  }
}

function normalizePair(p){
  if (!p) return null;
  return {
    chainId: p.chainId,
    dexId: p.dexId,
    pairAddress: p.pairAddress,
    url: p.url,
    baseToken: p.baseToken,
    quoteToken: p.quoteToken,
    priceUsd: p.priceUsd,
    fdv: p.fdv,
    marketCap: p.marketCap,
    liquidity: p.liquidity,
    volume: p.volume,
    priceChange: p.priceChange,
    txns: p.txns,
    info: p.info,
    pairCreatedAt: p.pairCreatedAt
  };
}

function pickBestPair(pairs){
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const score = (p) => {
    const liq = safeNum(p?.liquidity?.usd);
    const vol = safeNum(p?.volume?.h24);
    const tx = safeNum(p?.txns?.h24?.buys) + safeNum(p?.txns?.h24?.sells);
    return liq * 1e6 + vol * 10 + tx;
  };
  return [...pairs].sort((a,b)=>score(b)-score(a))[0];
}

function trendChange(bestPair, tf){
  const pc = bestPair?.priceChange || {};
  if (tf === "5m") return safeNum(pc.m5);
  if (tf === "10m") return safeNum(pc.m5) * 0.6 + safeNum(pc.m15) * 0.4;
  if (tf === "15m") return safeNum(pc.m15);
  if (tf === "1h") return safeNum(pc.h1);
  if (tf === "4h") return safeNum(pc.h4);
  if (tf === "1d") return safeNum(pc.h24);
  return safeNum(pc.m15);
}

function computeRisk(bestPair){
  if (!bestPair) return { riskScore: 85, riskLabel: "HIGH", flags:["NO_PAIR_DATA"] };

  const liq = safeNum(bestPair?.liquidity?.usd);
  const ch5 = Math.abs(safeNum(bestPair?.priceChange?.m5));
  const ch15 = Math.abs(safeNum(bestPair?.priceChange?.m15));

  const b5 = safeNum(bestPair?.txns?.m5?.buys);
  const s5 = safeNum(bestPair?.txns?.m5?.sells);
  const b15 = safeNum(bestPair?.txns?.m15?.buys);
  const s15 = safeNum(bestPair?.txns?.m15?.sells);
  const buys = b5 + b15;
  const sells = s5 + s15;
  const total = buys + sells;
  const buyRatio = (buys + 1) / (total + 2);

  const flags = [];
  let score = 25;

  if (liq < 1000) { score += 45; flags.push("MICRO_LIQUIDITY"); }
  else if (liq < 2500) { score += 35; flags.push("VERY_LOW_LIQUIDITY"); }
  else if (liq < 7500) { score += 25; flags.push("LOW_LIQUIDITY"); }
  else if (liq < 15000) { score += 15; }
  else if (liq < 30000) { score += 8; }

  if (ch5 > 25 || ch15 > 50) { score += 22; flags.push("EXTREME_SHORT_MOVE"); }
  else if (ch5 > 12 || ch15 > 25) { score += 12; flags.push("HIGH_VOLATILITY"); }

  if (liq < 7500 && (ch5 > 15 || ch15 > 30)) { score += 18; flags.push("MANIPULATION_RISK"); }

  if (total >= 25 && (buyRatio > 0.9 || buyRatio < 0.1)) { score += 14; flags.push("ANOMALOUS_FLOW"); }
  else if (total >= 15 && (buyRatio > 0.82 || buyRatio < 0.18)) { score += 8; flags.push("FLOW_IMBALANCE"); }

  if (total < 6) { score += 10; flags.push("LOW_ACTIVITY"); }

  const knife = safeNum(bestPair?.priceChange?.h1) < -10 && safeNum(bestPair?.priceChange?.h4) < -18 && safeNum(bestPair?.priceChange?.h24) < -35;
  if (knife) { score += 18; flags.push("FALLING_KNIFE"); }

  score = Math.max(0, Math.min(100, score));
  const riskLabel = score <= 35 ? "LOW" : score <= 65 ? "MED" : "HIGH";
  return { riskScore: score, riskLabel, flags };
}

function computeDumpRisk(bestPair){
  if (!bestPair) return { dumpRisk:"UNKNOWN", reasons:[] };
  const ch5 = safeNum(bestPair?.priceChange?.m5);
  const ch15 = safeNum(bestPair?.priceChange?.m15);
  const b5 = safeNum(bestPair?.txns?.m5?.buys);
  const s5 = safeNum(bestPair?.txns?.m5?.sells);
  const b15 = safeNum(bestPair?.txns?.m15?.buys);
  const s15 = safeNum(bestPair?.txns?.m15?.sells);
  const buys = b5 + b15;
  const sells = s5 + s15;
  const total = buys + sells;
  const buyRatio = (buys + 1) / (total + 2);

  const reasons = [];
  if (ch5 < -6) reasons.push("5m down");
  if (ch15 < -12) reasons.push("15m down");
  if (total >= 20 && buyRatio < 0.35) reasons.push("sell pressure");

  let dumpRisk = "LOW";
  if (reasons.length >= 2) dumpRisk = "HIGH";
  else if (reasons.length === 1) dumpRisk = "MED";
  return { dumpRisk, reasons };
}

function computeWhaleLike(bestPair){
  if (!bestPair) return { whaleScore:0, whaleLabel:"NONE", reasons:[] };
  const liq = safeNum(bestPair?.liquidity?.usd);
  const b5 = safeNum(bestPair?.txns?.m5?.buys);
  const s5 = safeNum(bestPair?.txns?.m5?.sells);
  const b15 = safeNum(bestPair?.txns?.m15?.buys);
  const s15 = safeNum(bestPair?.txns?.m15?.sells);
  const buys = b5 + b15;
  const sells = s5 + s15;
  const total = buys + sells;
  const buyRatio = (buys + 1) / (total + 2);
  const ch5 = safeNum(bestPair?.priceChange?.m5);
  const ch15 = safeNum(bestPair?.priceChange?.m15);
  const vol24 = safeNum(bestPair?.volume?.h24);

  let score = 0;
  const reasons = [];
  if (total >= 35) { score += 20; reasons.push("txn spike"); }
  if (buyRatio >= 0.68 && total >= 18) { score += 25; reasons.push("buy dominance"); }
  if (vol24 >= 300000) { score += 10; reasons.push("strong 24h vol"); }
  if (ch5 >= 2 || ch15 >= 4) { score += 10; reasons.push("price lift"); }
  if (liq < 2500) { score -= 25; reasons.push("very low liq"); }
  else if (liq < 7500) { score -= 12; reasons.push("low liq"); }
  if (Math.abs(ch5) > 35 || Math.abs(ch15) > 70) { score -= 10; reasons.push("too wild"); }

  score = Math.max(0, Math.min(100, score));
  const whaleLabel = score >= 70 ? "HIGH" : score >= 45 ? "MED" : score >= 25 ? "LOW" : "NONE";
  return { whaleScore: score, whaleLabel, reasons: reasons.slice(0,3) };
}

function computeSmartMoney(bestPair){
  const risk = computeRisk(bestPair);
  const whale = computeWhaleLike(bestPair);
  if (!bestPair) return { smartScore:0, smartLabel:"NONE", reasons:[] };

  // Hard vetoes for "smart money" quality.
  const dump = computeDumpRisk(bestPair);
  if (risk.flags.includes("FALLING_KNIFE")){
    return { smartScore:0, smartLabel:"NONE", reasons:["falling knife"] };
  }
  if (dump.dumpRisk === "HIGH"){
    return { smartScore:0, smartLabel:"NONE", reasons:["dump risk"] };
  }

  const ch5 = Math.abs(safeNum(bestPair?.priceChange?.m5));
  const ch15 = Math.abs(safeNum(bestPair?.priceChange?.m15));
  const controlled = (ch5 <= 16 && ch15 <= 30);
  let score = 0;
  const reasons = [];

  if (risk.riskLabel === "LOW") { score += 30; reasons.push("low risk"); }
  else if (risk.riskLabel === "MED") { score += 15; reasons.push("med risk"); }
  else { score -= 30; reasons.push("high risk"); }

  if (whale.whaleScore >= 45) { score += 25; reasons.push("smart flow"); }
  if (controlled) { score += 15; reasons.push("controlled move"); }
  else { score -= 10; reasons.push("too volatile"); }

  const b5 = safeNum(bestPair?.txns?.m5?.buys);
  const s5 = safeNum(bestPair?.txns?.m5?.sells);
  const b15 = safeNum(bestPair?.txns?.m15?.buys);
  const s15 = safeNum(bestPair?.txns?.m15?.sells);
  const buys = b5 + b15;
  const sells = s5 + s15;
  const total = buys + sells;
  const buyRatio = (buys + 1) / (total + 2);

  if (total >= 18) { score += 10; reasons.push("active tape"); }
  else { score -= 10; reasons.push("low activity"); }

  if (buyRatio >= 0.62 && total >= 16){ score += 12; reasons.push("buy pressure"); }
  else if (buyRatio < 0.45 && total >= 16){ score -= 14; reasons.push("sell pressure"); }

  // Penalize medium dump risk to keep the feed clean.
  if (dump.dumpRisk === "MED"){ score -= 10; reasons.push("elevated dump risk"); }

  score = Math.max(0, Math.min(100, score));
  const smartLabel = score >= 70 ? "HIGH" : score >= 50 ? "MED" : score >= 30 ? "LOW" : "NONE";
  return { smartScore: score, smartLabel, reasons: reasons.slice(0,3) };
}

function computePotential(bestPair, tf){
  const risk = computeRisk(bestPair);
  const dump = computeDumpRisk(bestPair);
  if (!bestPair) return { potential:"LOW", why:["no data"], buy:false, buyWhy:[] };

  if (risk.riskLabel === "HIGH") return { potential:"LOW", why:["high risk"], buy:false, buyWhy:[] };
  if (dump.dumpRisk === "HIGH") return { potential:"LOW", why:["dump risk"], buy:false, buyWhy:[] };

  const t = trendChange(bestPair, tf);

  const b5 = safeNum(bestPair?.txns?.m5?.buys);
  const s5 = safeNum(bestPair?.txns?.m5?.sells);
  const b15 = safeNum(bestPair?.txns?.m15?.buys);
  const s15 = safeNum(bestPair?.txns?.m15?.sells);
  const buys = b5 + b15;
  const sells = s5 + s15;
  const total = buys + sells;
  const buyRatio = (buys + 1) / (total + 2);

  const why = [];
  if (t > 0) why.push(`${tf} momentum up`);
  if (buyRatio >= 0.62 && total >= 12) why.push("buy flow");
  if (risk.riskLabel === "LOW") why.push("low risk");

  let potential = "LOW";
  if (t > 1.5 && buyRatio >= 0.6 && total >= 12 && risk.riskLabel !== "HIGH") potential = "MED";
  if (t > 3 && buyRatio >= 0.65 && total >= 18 && risk.riskLabel === "LOW") potential = "HIGH";

  const buyWhy = [];
  let buy = false;

  const ch1 = safeNum(bestPair?.priceChange?.h1);
  const ch4 = safeNum(bestPair?.priceChange?.h4);
  const ch24 = safeNum(bestPair?.priceChange?.h24);
  const gateA_deep = (ch1 < 0 || ch4 < 0 || ch24 < 0) && !(ch1 < -10 && ch4 < -18 && ch24 < -35);
  if (!gateA_deep) buyWhy.push("no dip setup");

  const gateB_reversal = (safeNum(bestPair?.priceChange?.m5) > 0 && safeNum(bestPair?.priceChange?.m15) > 0) || (safeNum(bestPair?.priceChange?.m15) > 2 && safeNum(bestPair?.priceChange?.m5) > -0.5);
  if (!gateB_reversal) buyWhy.push("no reversal confirmation");

  const gateC_risk = (risk.riskLabel !== "HIGH");
  if (!gateC_risk) buyWhy.push("risk veto");

  const flowOK = (buyRatio >= 0.62 && total >= 15);
  if (!flowOK) buyWhy.push("flow not strong");

  const activityOK = (total >= 10);
  if (!activityOK) buyWhy.push("low activity");

  const manipulationVeto = (risk.flags.includes("MANIPULATION_RISK") || risk.flags.includes("EXTREME_SHORT_MOVE"));
  if (manipulationVeto) buyWhy.push("manipulation risk");

  const dumpVeto = (dump.dumpRisk === "HIGH");
  if (dumpVeto) buyWhy.push("dump risk");

  const potentialOK = (potential !== "LOW");
  if (!potentialOK) buyWhy.push("potential too low");

  if (gateA_deep && gateB_reversal && gateC_risk && flowOK && activityOK && !manipulationVeto && !dumpVeto && potentialOK){
    buy = true;
    buyWhy.length = 0;
    buyWhy.push("deep setup + reversal + flow + low/med risk");
  }

  return { potential, why: why.slice(0,3), buy, buyWhy };
}

function identFromPair(bestPair, tokenAddress){
  const base = bestPair?.baseToken || {};
  const name = base?.name || "Token";
  const symbol = base?.symbol || "";
  const logo = bestPair?.info?.imageUrl || "";
  return { address: tokenAddress, name, symbol, logo };
}

function isTrash(bestPair){
  const risk = computeRisk(bestPair);
  const dump = computeDumpRisk(bestPair);
  if (dump.dumpRisk === "HIGH") return true;
  if (risk.riskLabel === "HIGH" && risk.riskScore >= 75) return true;
  if (risk.flags.includes("FALLING_KNIFE")) return true;
  if (risk.flags.includes("MANIPULATION_RISK") && risk.riskScore >= 70) return true;
  if (risk.flags.includes("MICRO_LIQUIDITY")) return true;
  return false;
}

async function tokenPairs(address){
  const url = `https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(address)}`;
  const raw = await fetchJson(url, 12000);
  const pairs = (Array.isArray(raw) ? raw : []).map(normalizePair);
  return pairs;
}

async function tokenDetail(address, tf){
  const pairs = await tokenPairs(address);
  const bestPair = pickBestPair(pairs);
  const ident = identFromPair(bestPair, address);
  const risk = computeRisk(bestPair);
  const dump = computeDumpRisk(bestPair);
  const whale = computeWhaleLike(bestPair);
  const smart = computeSmartMoney(bestPair);
  const pot = computePotential(bestPair, tf);

  const warnings = [];
  if (risk.flags.includes("LOW_LIQUIDITY") || risk.flags.includes("VERY_LOW_LIQUIDITY") || risk.flags.includes("MICRO_LIQUIDITY")) warnings.push({ level:"warn", text:"Low liquidity — price can be manipulated easily." });
  if (risk.flags.includes("FALLING_KNIFE")) warnings.push({ level:"danger", text:"Falling knife pattern — high dump risk, avoid catching a falling knife." });
  if (dump.dumpRisk === "HIGH") warnings.push({ level:"danger", text:"High dump risk — strong sell pressure detected." });
  if (risk.flags.includes("MANIPULATION_RISK")) warnings.push({ level:"danger", text:"Manipulation risk — extreme move with weak liquidity." });
  if (risk.flags.includes("ANOMALOUS_FLOW")) warnings.push({ level:"warn", text:"Anomalous flow — unusually one-sided tape (bots/wash possible)." });
  if (warnings.length === 0) warnings.push({ level:"ok", text:"No major red flags detected by heuristics (still DYOR)." });

  return { address, ident, bestPair, risk, dump, whale, smart, potential: pot, pairs: pairs.slice(0, 25), warnings };
}

// Jupiter token list (verified mints + logos) — used to resolve majors without hardcoding every mint.
const JUP_TOKEN_LIST_URL = "https://token.jup.ag/all";

async function getJupiterTokenList(){
  return await fetchJson(JUP_TOKEN_LIST_URL, 6 * 60 * 60 * 1000); // 6h
}

function pickJupiterToken(list, wantSymbol, wantName){
  const s = String(wantSymbol||"").toUpperCase();
  const n = String(wantName||"").toLowerCase();
  if (!Array.isArray(list) || !s) return null;

  const candidates = list.filter(t => String(t?.symbol||"").toUpperCase() === s);
  if (candidates.length === 0) return null;

  // Prefer verified/strict tokens if tags are present.
  const score = (t) => {
    const tags = Array.isArray(t?.tags) ? t.tags.map(x=>String(x).toLowerCase()) : [];
    const verified = tags.includes("verified") ? 5 : 0;
    const strict = tags.includes("strict") ? 3 : 0;
    const nameMatch = n && String(t?.name||"").toLowerCase() === n ? 4 : 0;
    const hasLogo = t?.logoURI ? 1 : 0;
    return verified + strict + nameMatch + hasLogo;
  };

  const sorted = [...candidates].sort((a,b)=>score(b)-score(a));
  return sorted[0] || null;
}

app.get("/api/health", (req,res)=>res.json({ ok:true }));

app.get("/api/search", async (req,res)=>{
  try{
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error:"Missing q" });
    const url = "https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(q);
    const data = await fetchJson(url, 10000);
    const pairs = (data?.pairs || []).filter(p => p?.chainId === "solana").map(normalizePair);

    const by = new Map();
    for (const p of pairs){
      const addr = p?.baseToken?.address;
      if (!addr) continue;
      const cur = by.get(addr);
      const liq = safeNum(p?.liquidity?.usd);
      const curLiq = safeNum(cur?.liquidity?.usd);
      if (!cur || liq > curLiq) by.set(addr, p);
    }

    const items = [...by.entries()].map(([address, bestPair])=>{
      const ident = identFromPair(bestPair, address);
      const risk = computeRisk(bestPair);
      return { address, ident, bestPair, risk };
    }).slice(0, 60);

    res.json({ q, count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/token/:address", async (req,res)=>{
  try{
    const address = String(req.params.address || "").trim();
    const tf = String(req.query.tf || "15m");
    const data = await tokenDetail(address, tf);
    res.json(data);
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

async function boostedSeed(limit, options = {}){
  const allowHighRisk = Boolean(options.allowHighRisk);
  const url = "https://api.dexscreener.com/token-boosts/top/v1";
  const raw = await fetchJson(url, 30000);
  const base = (Array.isArray(raw) ? raw : []).filter(x => x?.chainId === "solana").slice(0, limit);
  const out = [];
  for (const x of base){
    const addr = String(x.tokenAddress || "");
    if (!addr) continue;
    if (isMcBlacklisted(addr)) continue;
    try{
      const pairs = await tokenPairs(addr);
      const bestPair = pickBestPair(pairs);
      if (!bestPair) continue;
      if (updateMcCrash(addr, bestPair)) continue;
      if (!passesQualityGate(bestPair, allowHighRisk)) continue;
      const risk = computeRisk(bestPair);
      const dump = computeDumpRisk(bestPair);
      const whale = computeWhaleLike(bestPair);
      const smart = computeSmartMoney(bestPair);
      out.push({ address: addr, ident: identFromPair(bestPair, addr), bestPair, risk, dump, whale, smart });
    }catch(_){}
    if (out.length >= limit) break;
  }
  return out;
}

async function mapLimit(arr, limit, fn){
  const ret = [];
  let i = 0;
  const workers = new Array(Math.max(1, limit)).fill(0).map(async ()=>{
    while (i < arr.length){
      const idx = i++;
      try{ ret[idx] = await fn(arr[idx], idx); }
      catch(e){ ret[idx] = null; }
    }
  });
  await Promise.all(workers);
  return ret.filter(Boolean);
}

function buildSmartMoneyList(seed, tf){
  const nowTs = now();
  const withStreak = seed
    .filter(x => !isMcBlacklisted(x.address))
    .map(x => {
      const smartScore = x.smart?.smartScore || 0;
      const key = String(x.address||"");
      const prev = smartSeen.get(key);
      let streak = 0;
      // Consider it a "valid tick" only if it clears basic quality.
      const valid = smartScore >= 55 && x.risk.riskLabel !== "HIGH" && (x.dump?.dumpRisk||"LOW") !== "HIGH" && !x.risk.flags.includes("FALLING_KNIFE");
      if (valid){
        if (prev && (nowTs - prev.ts) < 120000 && prev.lastScore >= 55) streak = Math.min(5, (prev.streak || 1) + 1);
        else streak = 1;
        smartSeen.set(key, { streak, lastScore: smartScore, ts: nowTs });
      }else{
        if (prev && (nowTs - prev.ts) < 120000) streak = prev.streak || 0;
      }
      const potential = computePotential(x.bestPair, tf);
      return { ...x, smartScore, smartStreak: streak, potential, showBuy: Boolean(potential.buy), buyWhy: potential.buyWhy };
    });

  return withStreak
    .filter(x => x.risk.riskLabel !== "HIGH")
    // Stability gate: show immediately if very strong; otherwise require 2 ticks.
    .filter(x => (x.smartScore >= 70) || (x.smartScore >= 55 && x.smartStreak >= 2))
    .sort((a,b)=> (b.smartScore + (b.smartStreak>=2?6:0)) - (a.smartScore + (a.smartStreak>=2?6:0)))
    .slice(0, 30);
}

function buildWhaleAlertList(seed, tf){
  return seed
    .map(x => {
      const potential = computePotential(x.bestPair, tf);
      return { ...x, whaleScore: x.whale?.whaleScore || 0, potential, showBuy: Boolean(potential.buy), buyWhy: potential.buyWhy };
    })
    .filter(x => x.whaleScore >= 45 && x.risk.riskLabel !== "HIGH")
    .sort((a,b)=> (b.whaleScore - a.whaleScore))
    .slice(0, 30);
}

function buildHotBuysList(seed, tf){
  return seed
    .map(x=>{
      const b5 = safeNum(x.bestPair?.txns?.m5?.buys);
      const s5 = safeNum(x.bestPair?.txns?.m5?.sells);
      const b15 = safeNum(x.bestPair?.txns?.m15?.buys);
      const s15 = safeNum(x.bestPair?.txns?.m15?.sells);
      const buys = b5 + b15;
      const sells = s5 + s15;
      const total = buys + sells;
      const buyRatio = (buys+1)/(total+2);
      const dump = x.dump || computeDumpRisk(x.bestPair);
      const ch5 = Math.abs(safeNum(x.bestPair?.priceChange?.m5));
      const ch15 = Math.abs(safeNum(x.bestPair?.priceChange?.m15));
      const controlled = (ch5 <= 18 && ch15 <= 35);

      // Base: activity + buy dominance
      let score = total * 2 + (buyRatio*100);

      // Bonus: smart money intersection
      const smartScore = x.smart?.smartScore || 0;
      if (smartScore >= 55) score += 18;
      else if (smartScore >= 40) score += 8;

      // Penalties: avoid pump/dump & migration dumps
      if (!controlled) score -= 14;
      if (dump.dumpRisk === "MED") score -= 10;
      if (dump.dumpRisk === "HIGH") score -= 40;
      if (x.risk.flags.includes("FALLING_KNIFE")) score -= 40;

      const potential = computePotential(x.bestPair, tf);
      return { ...x, hotScore: score, buyRatio, totalTx: total, dump, potential, showBuy: Boolean(potential.buy), buyWhy: potential.buyWhy };
    })
    .filter(x => x.totalTx >= 16 && x.buyRatio >= 0.62)
    .filter(x => x.risk.riskLabel !== "HIGH")
    .filter(x => (x.dump?.dumpRisk || "LOW") !== "HIGH")
    .filter(x => !x.risk.flags.includes("FALLING_KNIFE"))
    .sort((a,b)=> b.hotScore - a.hotScore)
    .slice(0, 30);
}

function buildSignalPlusList(seed, tf, potentialTier){
  const items = seed.map(x=>{
    const pot = computePotential(x.bestPair, tf);
    return { ...x, potential: pot };
  })
  .filter(x => x?.bestPair && !isTrash(x.bestPair))
  .filter(x => x.risk.riskLabel !== "HIGH")
  // Stronger quality gates: avoid pump-to-dex dump patterns, manipulation risk, and ultra-thin liquidity.
  .filter(x => {
    const liq = safeNum(x.bestPair?.liquidity?.usd);
    const flags = x.risk?.flags || [];
    const dumpRisk = x.dump?.dumpRisk || computeDumpRisk(x.bestPair).dumpRisk;

    // Hard vetoes
    if (dumpRisk === "HIGH") return false;
    if (flags.includes("MICRO_LIQUIDITY")) return false;
    if (flags.includes("MANIPULATION_RISK")) return false;

    // Potential-tier-specific gates
    if (potentialTier === "HIGH"){
      if (x.potential.potential !== "HIGH") return false;
      if (x.risk.riskLabel !== "LOW") return false;
      if (dumpRisk !== "LOW") return false;
      if (flags.includes("VERY_LOW_LIQUIDITY") || flags.includes("LOW_LIQUIDITY")) return false;
      if (flags.includes("ANOMALOUS_FLOW") || flags.includes("FALLING_KNIFE")) return false;
      if (liq < 2500) return false;
      return true;
    }
    if (potentialTier === "MED"){
      if (!(x.potential.potential === "MED" || x.potential.potential === "HIGH")) return false;
      if (x.risk.riskScore > 55) return false;
      if (flags.includes("FALLING_KNIFE")) return false;
      if (liq < 1800) return false;
      return true;
    }
    // LOW potential: keep very strict to avoid rugs; it's ok if list is short.
    if (potentialTier === "LOW"){
      if (x.risk.riskScore > 65) return false;
      if (dumpRisk !== "LOW") return false;
      if (flags.includes("VERY_LOW_LIQUIDITY") || flags.includes("LOW_LIQUIDITY")) return false;
      if (liq < 2200) return false;
      return true;
    }
    return true;
  })
  .map(x => ({ ...x, showBuy: Boolean(x.potential.buy), buyWhy: x.potential.buyWhy }))
  .filter(x => x.showBuy)
  .sort((a,b)=>{
    const pRank = (p)=> p==="HIGH"?3:p==="MED"?2:1;
    const d = pRank(b.potential.potential) - pRank(a.potential.potential);
    if (d !== 0) return d;
    const r = a.risk.riskScore - b.risk.riskScore;
    if (r !== 0) return r;
    return trendChange(b.bestPair, tf) - trendChange(a.bestPair, tf);
  })
  .slice(0, 30);

  return items;
}

app.get("/api/list/majors", async (req,res)=>{
  try{
    const tf = String(req.query.tf || "15m");
    const majorsPath = path.join(__dirname, "..", "majors.json");
    delete require.cache[require.resolve(majorsPath)];
    const list = require(majorsPath);
    const jupList = await getJupiterTokenList().catch(()=>[]);

    const enriched = await mapLimit(list, 4, async (t)=>{
      // Enforce user rule: no stablecoins / no staked-SOL wrappers in Majors list.
      if (isStableSymbol(t.symbol) || isLSTSymbol(t.symbol)) return null;

      const token = t.address ? null : pickJupiterToken(jupList, t.symbol, t.name);
      const address = String(t.address || token?.address || "").trim();
      if (!address) return null;
      if (isMcBlacklisted(address)) return null;

      const pairs = await tokenPairs(address);
      const bestPair = pickBestPair(pairs);
      if (!bestPair) return null;
      if (updateMcCrash(address, bestPair)) return null;
      if (!passesQualityGate(bestPair)) return null;

      const ident = { address, name: t.name || (bestPair?.baseToken?.name||"Token"), symbol: t.symbol || (bestPair?.baseToken?.symbol||""), logo: bestPair?.info?.imageUrl || token?.logoURI || "" };
      const risk = computeRisk(bestPair);
      const dump = computeDumpRisk(bestPair);
      const pot = computePotential(bestPair, tf);
      return { address, ident, bestPair, risk, dump, potential: pot };
    });

    const items = enriched.filter(Boolean);
    updatePeaks(items);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/trending_low_risk", async (req,res)=>{
  try{
    const tf = String(req.query.tf || "15m");
    const seed = await boostedSeed(28);
    const items = seed
      .filter(x => x?.bestPair && x?.risk?.riskLabel !== "HIGH")
      .map(x => ({ ...x, trend: trendChange(x.bestPair, tf) }))
      .sort((a,b)=> (a.risk.riskScore - b.risk.riskScore) || (b.trend - a.trend))
      .slice(0, 30);
    updatePeaks(items);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/top_volume", async (req,res)=>{
  try{
    const seed = await boostedSeed(36);
    const items = seed
      .map(x => ({ ...x, vol24: safeNum(x.bestPair?.volume?.h24) }))
      .sort((a,b)=> b.vol24 - a.vol24)
      .slice(0, 30);
    updatePeaks(items);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/high_liquidity", async (req,res)=>{
  try{
    const seed = await boostedSeed(36);
    const items = seed
      .map(x => ({ ...x, liq: safeNum(x.bestPair?.liquidity?.usd) }))
      .sort((a,b)=> b.liq - a.liq)
      .slice(0, 30);
    updatePeaks(items);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/whale_alert", async (req,res)=>{
  try{
    const tf = String(req.query.tf || "15m");
    const seed = await boostedSeed(40);
    const items = buildWhaleAlertList(seed, tf);
    updatePeaks(items);
    trackBuySignals(items, "Whale Alert");
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/smart_money", async (req,res)=>{
  try{
    const tf = String(req.query.tf || "15m");
    const seed = await boostedSeed(42);
    const items = buildSmartMoneyList(seed, tf);
    updatePeaks(items);
    trackBuySignals(items, "Smart Money");
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/hot_buys", async (req,res)=>{
  try{
    const tf = String(req.query.tf || "15m");
    const seed = await boostedSeed(42);
    const items = buildHotBuysList(seed, tf);
    updatePeaks(items);
    trackBuySignals(items, "Hot Buys");
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/risky", async (req,res)=>{
  try{
    const seed = await boostedSeed(42, { allowHighRisk: true });
    const items = seed
      .filter(x => x.risk.riskLabel === "HIGH" && !x.risk.flags.includes("MICRO_LIQUIDITY"))
      .filter(x => (x.dump?.dumpRisk || "LOW") !== "HIGH")
      .filter(x => !x.risk.flags.includes("FALLING_KNIFE"))
      .sort((a,b)=> b.risk.riskScore - a.risk.riskScore)
      .slice(0, 30);
    updatePeaks(items);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/uptrend_signal", async (req,res)=>{
  try{
    const tf = String(req.query.tf || "15m");
    const potential = String(req.query.potential || "MED");
    const seed = await boostedSeed(55);
    const items = buildSignalPlusList(seed, tf, potential);
    updatePeaks(items);
    trackBuySignals(items, "Signal+");

    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/all_signals", async (req,res)=>{
  try{
    const tf = String(req.query.tf || "15m");
    const potential = String(req.query.potential || "MED");
    const seed = await boostedSeed(60);

    const smart = buildSmartMoneyList(seed, tf);
    const whale = buildWhaleAlertList(seed, tf);
    const hot = buildHotBuysList(seed, tf);
    const signal = buildSignalPlusList(seed, tf, potential);
    trackBuySignals(smart, "Smart Money");
    trackBuySignals(whale, "Whale Alert");
    trackBuySignals(hot, "Hot Buys");
    trackBuySignals(signal, "Signal+");

    const by = new Map();
    const merge = (list, source)=>{
      for (const item of list){
        const key = String(item.address || "");
        if (!key) continue;
        const existing = by.get(key);
        if (!existing){
          by.set(key, { ...item, sources: [source], showBuy: Boolean(item.showBuy) });
        }else{
          existing.sources = Array.from(new Set([...(existing.sources || []), source]));
          existing.showBuy = Boolean(existing.showBuy || item.showBuy);
          if (!existing.buyWhy && item.buyWhy) existing.buyWhy = item.buyWhy;
        }
      }
    };

    merge(smart, "Smart Money");
    merge(whale, "Whale Alert");
    merge(hot, "Hot Buys");
    merge(signal, "Signal+");

    const items = Array.from(by.values())
      .sort((a,b)=>{
        const buy = (b.showBuy ? 1 : 0) - (a.showBuy ? 1 : 0);
        if (buy !== 0) return buy;
        return (a.risk?.riskScore || 0) - (b.risk?.riskScore || 0);
      })
      .slice(0, 60);
    updatePeaks(items);

    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/performance_history", (req,res)=>{
  try{
    const items = perfHistory.listEntries();
    res.json({ count: items.length, items, path: perfHistory.PERF_HISTORY_PATH });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});


app.get("/api/list/boosted", async (req,res)=>{
  try{
    const seed = await boostedSeed(40);
    // boostedSeed already comes from DexScreener boosts; keep order by liquidity then volume as best-pair,
    // but we can roughly prefer higher liquidity as "quality boosted".
    const items = seed
      .map(x => ({...x, liq: safeNum(x.bestPair?.liquidity?.usd), vol24: safeNum(x.bestPair?.volume?.h24)}))
      .sort((a,b)=> (b.liq - a.liq) || (b.vol24 - a.vol24))
      .slice(0, 30);
    updatePeaks(items);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});


const publicDir = path.join(__dirname, "..", "public");
app.use("/", express.static(publicDir));
app.get("*", (req,res)=>res.sendFile(path.join(publicDir, "index.html")));

module.exports = app;
