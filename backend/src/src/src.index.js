const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3001;

// Frontend (public) serve
app.use(express.static(path.join(__dirname, "..", "public")));

// Simple healthcheck
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Example endpoint (later: real tokens)
app.get("/api/tokens", (req, res) => {
  res.json([]);
});

// SPA fallback (if you have index.html in public)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
