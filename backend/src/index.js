const app = require("./app");

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`dexPulse V8 running on http://localhost:${PORT}`));
