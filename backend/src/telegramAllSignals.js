const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const API_PORT = process.env.DEXPULSE_API_PORT || process.env.PORT || 3001;
const BASE_URL = process.env.DEXPULSE_BASE_URL || `http://localhost:${API_PORT}`;
const TF = process.env.ALL_SIGNALS_TF || "15m";
const POTENTIAL = process.env.ALL_SIGNALS_POTENTIAL || "MED";
const INTERVAL_MS = Number(process.env.ALL_SIGNALS_INTERVAL_MS || 20000);
const STATE_PATH = process.env.ALL_SIGNALS_STATE_PATH || "/var/data/telegram_all_signals.json";
const TTL_MS = Number(process.env.ALL_SIGNALS_TTL_MS || 24 * 60 * 60 * 1000);
const SEND_DELAY_MS = Number(process.env.ALL_SIGNALS_SEND_DELAY_MS || 600);
const RESET_STATE = /^(1|true|yes)$/i.test(process.env.ALL_SIGNALS_RESET_STATE || "");
const FORCE_RESEND = /^(1|true|yes)$/i.test(process.env.ALL_SIGNALS_FORCE_RESEND || "");
const TEST_MESSAGE = String(process.env.TELEGRAM_TEST_MESSAGE || "").trim();

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

function resolveAddress(item) {
  const addr =
    item?.address ||
    item?.ident?.address ||
    item?.bestPair?.baseToken?.address ||
    "";
  return String(addr).trim();
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
  const address = resolveAddress(item);
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
    throw new Error(`AllSignals fetch failed ${res.status} (${url}): ${text.slice(0, 200)}`);
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
  const bodyText = await res.text().catch(() => "");
  let payload;
  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch (_) {
    payload = null;
  }

  if (!res.ok) {
    throw new Error(`Telegram send failed ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  if (payload && payload.ok === false) {
    const description = payload.description || "Unknown Telegram API error.";
    throw new Error(`Telegram send failed: ${description}`);
  }
}

async function runOnce(state) {
  const items = await fetchAllSignals();
  if (!items.length) {
    console.log("AllSignals: no items returned.");
    return;
  }

  pruneState(state);
  let sentCount = 0;
  let skippedCount = 0;

  for (const item of items) {
    const address = resolveAddress(item);
    if (!address) continue;
    if (!FORCE_RESEND && state.sent[address]) {
      skippedCount += 1;
      continue;
    }

    const message = formatMessage(item);
    await sendTelegramMessage(message);
    state.sent[address] = now();
    sentCount += 1;

    if (SEND_DELAY_MS > 0) await sleep(SEND_DELAY_MS);
  }

  if (sentCount > 0) saveState(state);
  if (sentCount === 0 && skippedCount > 0) {
    console.log(`AllSignals: ${skippedCount} items skipped (already sent).`);
  }
}

async function start() {
  if (TEST_MESSAGE) {
    await sendTelegramMessage(TEST_MESSAGE);
    console.log("Telegram test message sent.");
    return;
  }

  let state = loadState();
  if (RESET_STATE) {
    state = { sent: {} };
    saveState(state);
    console.log("AllSignals state reset by ALL_SIGNALS_RESET_STATE.");
  }
  console.log("AllSignals Telegram notifier started.");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Interval: ${INTERVAL_MS}ms | TF=${TF} | Potential=${POTENTIAL}`);
  console.log(`Force resend: ${FORCE_RESEND ? "enabled" : "disabled"}`);

  await runOnce(state).catch(err => console.error(err.message));
  setInterval(() => {
    runOnce(state).catch(err => console.error(err.message));
  }, INTERVAL_MS);
}

start().catch(err => {
  console.error(err.message);
  process.exit(1);
});
