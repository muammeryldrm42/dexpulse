const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = process.env.DEXPULSE_BASE_URL || "http://localhost:3000";
const TF = process.env.ALL_SIGNALS_TF || "15m";
const POTENTIAL = process.env.ALL_SIGNALS_POTENTIAL || "MED";
const INTERVAL_MS = Number(process.env.ALL_SIGNALS_INTERVAL_MS || 20000);
const STATE_PATH = process.env.ALL_SIGNALS_STATE_PATH || "/var/data/telegram_all_signals.json";
const TTL_MS = Number(process.env.ALL_SIGNALS_TTL_MS || 24 * 60 * 60 * 1000);
const SEND_DELAY_MS = Number(process.env.ALL_SIGNALS_SEND_DELAY_MS || 600);

if (!BOT_TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN env var.");
}
if (!CHAT_ID) {
  throw new Error("Missing TELEGRAM_CHAT_ID env var.");
}

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { sent: {} };
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { sent: parsed.sent || {} };
    }
  } catch (_) {}
  return { sent: {} };
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Failed to save state:", err.message);
  }
}

function pruneState(state) {
  const cutoff = now() - TTL_MS;
  for (const [addr, ts] of Object.entries(state.sent || {})) {
    if (!ts || ts < cutoff) delete state.sent[addr];
  }
}

function formatUsd(value, digits = 6) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  if (num >= 1) return `$${num.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  return `$${num.toFixed(digits)}`;
}

function formatNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  return `$${num.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function buildDexscreenerUrl(item) {
  if (item?.bestPair?.url) return item.bestPair.url;
  if (item?.bestPair?.pairAddress) {
    return `https://dexscreener.com/solana/${item.bestPair.pairAddress}`;
  }
  if (item?.address) {
    return `https://dexscreener.com/solana/${item.address}`;
  }
  return "";
}

function formatMessage(item) {
  const name = item?.ident?.name || item?.bestPair?.baseToken?.name || "Token";
  const symbol = item?.ident?.symbol || item?.bestPair?.baseToken?.symbol || "";
  const address = item?.address || "";
  const price = formatUsd(item?.bestPair?.priceUsd);
  const marketCap = item?.bestPair?.marketCap || item?.bestPair?.fdv;
  const marketCapText = formatNumber(marketCap);
  const sources = Array.isArray(item?.sources) ? item.sources.join(", ") : "All Signals";
  const dexUrl = buildDexscreenerUrl(item);

  const lines = [
    "🔔 New AllSignals",
    `Token: ${name}${symbol ? ` (${symbol})` : ""}`,
    `CA: ${address}`,
    `Price: ${price}`,
    `Market Cap: ${marketCapText}`,
    `Source: ${sources}`
  ];

  if (dexUrl) lines.push(`Dexscreener: ${dexUrl}`);

  return lines.join("\n");
}

async function fetchAllSignals() {
  const url = `${BASE_URL}/api/list/all_signals?tf=${encodeURIComponent(TF)}&potential=${encodeURIComponent(POTENTIAL)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AllSignals fetch failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data?.items) ? data.items : [];
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: false
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram send failed ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function runOnce(state) {
  const items = await fetchAllSignals();
  if (!items.length) return;

  pruneState(state);
  let sentCount = 0;

  for (const item of items) {
    const address = String(item?.address || "").trim();
    if (!address) continue;
    if (state.sent[address]) continue;

    const message = formatMessage(item);
    await sendTelegramMessage(message);
    state.sent[address] = now();
    sentCount += 1;

    if (SEND_DELAY_MS > 0) await sleep(SEND_DELAY_MS);
  }

  if (sentCount > 0) saveState(state);
}

async function start() {
  const state = loadState();
  console.log("AllSignals Telegram notifier started.");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Interval: ${INTERVAL_MS}ms | TF=${TF} | Potential=${POTENTIAL}`);

  await runOnce(state).catch(err => console.error(err.message));
  setInterval(() => {
    runOnce(state).catch(err => console.error(err.message));
  }, INTERVAL_MS);
}

start().catch(err => {
  console.error(err.message);
  process.exit(1);
});
