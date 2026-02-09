const $ = (s)=>document.querySelector(s);

const tf = "1d";
const listHint = $("#listHint");
let searchTimer = null;

function fmtUSD(n){
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (x >= 1e9) return `$${(x/1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x/1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x/1e3).toFixed(1)}K`;
  if (x >= 1) return `$${x.toFixed(4)}`;
  return `$${x.toPrecision(3)}`;
}
function fmtNum(n){
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (x >= 1e9) return `${(x/1e9).toFixed(2)}B`;
  if (x >= 1e6) return `${(x/1e6).toFixed(2)}M`;
  if (x >= 1e3) return `${(x/1e3).toFixed(1)}K`;
  return `${x.toFixed(2)}`;
}
function pct(n){
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  const s = x >= 0 ? "+" : "";
  return `${s}${x.toFixed(2)}%`;
}
function trendValue(pair, timeframe){
  const p = pair || {};
  if (timeframe === "5m") return p?.priceChange?.m5;
  if (timeframe === "10m") return (0.6 * (p?.priceChange?.m5 || 0)) + (0.4 * (p?.priceChange?.m15 || 0));
  if (timeframe === "15m") return p?.priceChange?.m15;
  if (timeframe === "1h") return p?.priceChange?.h1;
  if (timeframe === "4h") return p?.priceChange?.h4;
  if (timeframe === "1d") return p?.priceChange?.h24;
  return p?.priceChange?.m15;
}
function logoHtml(url, symbol){
  if (url) return `<img src="${url}" alt="logo" onerror="this.style.display='none'; this.parentElement.textContent='${(symbol||'?').slice(0,1)}';">`;
  return (symbol||"?").slice(0,1);
}
function setStatus(msg){ $("#status").textContent = msg || ""; }

async function api(path){
  const res = await fetch(path);
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "Request failed");
  return j;
}

function currentListEndpoint(){
  return `/api/list/majors?tf=${encodeURIComponent(tf)}`;
}

function renderCards(items){
  const grid = $("#grid");
  grid.innerHTML = "";

  if (!items || items.length === 0){
    grid.innerHTML = `<div class="card muted">No tokens found. Try a different search.</div>`;
    return;
  }

  for (const it of items){
    const ident = it.ident || {};
    const p = it.bestPair || {};
    const price = p.priceUsd ? Number(p.priceUsd) : null;
    const liq = p?.liquidity?.usd;
    const vol24 = p?.volume?.h24;
    const mc = p?.marketCap;
    const change = trendValue(p, tf);
    const txns24 = p?.txns?.h24;
    const buys24 = txns24?.buys || 0;
    const sells24 = txns24?.sells || 0;

    const card = document.createElement("div");
    card.className = "card tokenCard tokenRowCard";
    card.innerHTML = `
      <div class="tokenRow">
        <div class="left">
          <div class="logo">${logoHtml(ident.logo, ident.symbol)}</div>
          <div class="title">
            <div class="name" title="${(ident.name||"").replaceAll('"','')}">${ident.name||"Token"}</div>
            <div class="sym">${ident.symbol || ""}</div>
          </div>
        </div>
        <div class="tokenStats">
          <div class="stat"><div class="k">Price</div><div class="v">${price ? fmtUSD(price) : "—"}</div></div>
          <div class="stat"><div class="k">24h</div><div class="v ${change >= 0 ? "up" : "down"}">${pct(change)}</div></div>
          <div class="stat"><div class="k">Liquidity</div><div class="v">${fmtUSD(liq)}</div></div>
          <div class="stat"><div class="k">Volume</div><div class="v">${fmtUSD(vol24)}</div></div>
          <div class="stat"><div class="k">Market Cap</div><div class="v">${fmtUSD(mc)}</div></div>
          <div class="stat"><div class="k">24h Txns</div><div class="v">${fmtNum(buys24)} / ${fmtNum(sells24)}</div></div>
          <div class="stat"><div class="k">DEX</div><div class="v">${(p?.dexId || "—").toUpperCase?.() || "—"}</div></div>
        </div>
      </div>
    `;
    card.addEventListener("click", ()=>openDetail(it.address));
    grid.appendChild(card);
  }
}

function geckoEmbedUrl(pairAddress, resolution){
  const resMap = { "5m":"5m", "10m":"5m", "15m":"15m", "1h":"1h", "4h":"4h", "1d":"1d" };
  const r = resMap[resolution] || "15m";
  return `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(pairAddress)}?embed=1&info=0&swaps=0&light_chart=0&resolution=${encodeURIComponent(r)}`;
}

async function openDetail(address){
  try{
    setStatus("Loading token…");
    const data = await api(`/api/token/${encodeURIComponent(address)}?tf=${encodeURIComponent(tf)}`);
    setStatus("");

    const ident = data.ident || {};
    const p = data.bestPair || {};
    const warnings = data.warnings || [];

    const dsUrl = p?.url || (ident.address ? `https://dexscreener.com/solana/${ident.address}` : "#");
    const gtUrl = p?.pairAddress ? `https://www.geckoterminal.com/solana/pools/${p.pairAddress}` : "#";

    const chartHtml = p?.pairAddress
      ? `<div class="chartBox"><iframe src="${geckoEmbedUrl(p.pairAddress, tf)}" loading="lazy"></iframe></div>`
      : `<div class="card muted">Chart unavailable — <a href="${dsUrl}" target="_blank" rel="noreferrer">Open on DexScreener</a></div>`;

    const warnHtml = warnings.map(w=>{
      const cls = w.level === "danger" ? "danger" : w.level === "warn" ? "warn" : "ok";
      return `<div class="warnItem ${cls}">${w.text}</div>`;
    }).join("");

    $("#detail").innerHTML = `
      <div class="detailHead">
        <div class="logo">${logoHtml(ident.logo, ident.symbol)}</div>
        <div class="title" style="min-width:0">
          <div class="name">${ident.name || "Token"}</div>
          <div class="sym">${ident.symbol || ""}</div>
          <div class="small muted" style="margin-top:4px;word-break:break-all">${ident.address || ""}</div>
        </div>
      </div>

      <div class="linkRow">
        <span class="muted">Markets:</span>
        <a href="${dsUrl}" target="_blank" rel="noreferrer">DexScreener</a>
        <a href="${gtUrl}" target="_blank" rel="noreferrer">GeckoTerminal</a>
      </div>

      <div class="hr"></div>

      ${chartHtml}

      <div class="hr"></div>

      <div class="metrics">
        <div class="kv"><div class="k">Price</div><div class="v">${p.priceUsd ? fmtUSD(Number(p.priceUsd)) : "—"}</div></div>
        <div class="kv"><div class="k">24h Change</div><div class="v">${pct(trendValue(p, tf))}</div></div>
        <div class="kv"><div class="k">Liquidity</div><div class="v">${fmtUSD(p?.liquidity?.usd)}</div></div>
        <div class="kv"><div class="k">Vol (24h)</div><div class="v">${fmtUSD(p?.volume?.h24)}</div></div>
        <div class="kv"><div class="k">MC</div><div class="v">${fmtUSD(p?.marketCap)}</div></div>
        <div class="kv"><div class="k">Buys/Sells (15m)</div><div class="v">${fmtNum(p?.txns?.m15?.buys)} / ${fmtNum(p?.txns?.m15?.sells)}</div></div>
      </div>

      <div class="hr"></div>

      <div class="warnings">
        ${warnHtml}
      </div>
    `;

  }catch(e){
    setStatus("");
    $("#detail").innerHTML = `<div class="card"><div class="muted">Failed to load token detail.</div><div class="small" style="margin-top:8px;color:#fca5a5">${String(e.message||e)}</div></div>`;
  }
}

async function loadList(){
  try{
    setStatus("Loading…");
    const endpoint = currentListEndpoint();
    const data = await api(endpoint);
    const items = data.items || [];
    renderCards(items);
    setStatus(`Showing ${items.length} tokens`);
    listHint.textContent = "Majors snapshot • 24h change";
  }catch(e){
    setStatus("");
    $("#grid").innerHTML = `<div class="card"><div class="muted">Failed to load list.</div><div class="small" style="margin-top:8px;color:#fca5a5">${String(e.message||e)}</div></div>`;
  }
}

async function runSearch(){
  const q = $("#q").value.trim();
  if (!q){
    await loadList();
    return;
  }
  try{
    setStatus("Searching…");
    listHint.textContent = "Search results";
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    setStatus(`Search results: ${data.items.length}`);
    renderCards(data.items.map(x=>({ address:x.address, ident:x.ident, bestPair:x.bestPair })));
  }catch(e){
    setStatus("");
    $("#grid").innerHTML = `<div class="card"><div class="muted">Search failed.</div><div class="small" style="margin-top:8px;color:#fca5a5">${String(e.message||e)}</div></div>`;
  }
}

$("#q").addEventListener("input", ()=>{
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(()=>{ runSearch(); }, 350);
});
$("#q").addEventListener("keydown",(e)=>{ if (e.key === "Enter") runSearch(); });

(async ()=>{
  try{ await api("/api/health"); }catch(_){}
  loadList();
})();
