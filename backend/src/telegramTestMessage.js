const fetch = require("node-fetch");

const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const TEST_MESSAGE =
  String(process.env.TELEGRAM_TEST_MESSAGE || "").trim() ||
  process.argv.slice(2).join(" ").trim();

if (!BOT_TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN env var.");
}
if (!CHAT_ID) {
  throw new Error("Missing TELEGRAM_CHAT_ID env var.");
}
if (!TEST_MESSAGE) {
  throw new Error("Provide TELEGRAM_TEST_MESSAGE or pass a message argument.");
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

sendTelegramMessage(TEST_MESSAGE)
  .then(() => {
    console.log("Telegram test message sent.");
  })
  .catch(err => {
    console.error(err.message);
    process.exit(1);
  });
