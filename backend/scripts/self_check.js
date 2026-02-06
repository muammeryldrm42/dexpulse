const path = require("path");

process.env.PERF_HISTORY_PATH = process.env.PERF_HISTORY_PATH || path.join(__dirname, "..", "tmp", "perf_history_check.json");

const perfHistory = require("../src/performanceHistory");

const sample = {
  address: "TEST1111111111111111111111111111111111111",
  source: "Signal+",
  ident: { name: "SelfCheck Token", symbol: "SCHK", logo: "" },
  mc: 100000
};

perfHistory.recordBuySignal(sample);
perfHistory.updatePeak(sample.address, 175000);
perfHistory.markRemoved(sample.address, "fast_dump");

const entries = perfHistory.listEntries().filter(entry => entry.address === sample.address);
console.log(JSON.stringify({ count: entries.length, entries }, null, 2));
