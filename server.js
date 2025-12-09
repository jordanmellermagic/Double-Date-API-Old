import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Store configuration and last-known values
let CONFIG = {
  gooKey: null,
  gooUserId: null,
  openAIKey: null,

  last_value: null,
  last_hash: null,

  formatted_date: null,
  days_lived: null,

  autopoll: false,
  intervalMs: 5000,
  autopollHandle: null
};

// -----------------------------
// Helpers
// -----------------------------

function calculateDaysLived(dateString) {
  const d = new Date(dateString);
  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

async function fetchFromGoo(userId, apiKey) {
  const url = `https://11q.co/api/last/${userId}?key=${apiKey}`;
  const res = await axios.get(url);
  return res.data;
}

// Hash function to detect change in GOO data
function simpleHash(obj) {
  return JSON.stringify(obj);
}

async function askOpenAI(rawText, key) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Extract a birthdate from this text and respond ONLY in YYYY-MM-DD format."
        },
        { role: "user", content: rawText }
      ]
    },
    { headers: { Authorization: `Bearer ${key}` } }
  );

  return res.data.choices[0].message.content.trim();
}

// ----------------------------------------------
// CORE CHANGE DETECTION POLLING CYCLE
// ----------------------------------------------
async function runPollingCycle() {
  try {
    const { gooUserId, gooKey, openAIKey } = CONFIG;

    if (!gooUserId || !gooKey || !openAIKey) {
      console.log("Polling skipped — missing configuration.");
      return;
    }

    // 1. Fetch from GOO
    const gooData = await fetchFromGoo(gooUserId, gooKey);
    const newHash = simpleHash(gooData);

    // 2. Compare with last hash
    if (newHash !== CONFIG.last_hash) {
      console.log("🔄 GOO data changed — processing...");

      CONFIG.last_hash = newHash;
      CONFIG.last_value = gooData;

      // 3. Ask OpenAI for formatted date
      const formatted = await askOpenAI(JSON.stringify(gooData), openAIKey);
      CONFIG.formatted_date = formatted;

      // 4. Compute days lived
      CONFIG.days_lived = calculateDaysLived(formatted);

      console.log("✅ Updated:", {
        formatted_date: formatted,
        days_lived: CONFIG.days_lived
      });

    } else {
      console.log("⏭️ No change detected — skipping OpenAI.");
    }

  } catch (err) {
    console.error("Polling cycle error:", err.toString());
  }
}

// ----------------------------------------------
// Manual trigger (runs one cycle)
// ----------------------------------------------
app.post("/trigger", async (req, res) => {
  await runPollingCycle();
  res.json({
    formatted_date: CONFIG.formatted_date,
    days_lived: CONFIG.days_lived
  });
});

// ----------------------------------------------
// AUTOPOLL CONTROL
// ----------------------------------------------
app.post("/start-autopoll", (req, res) => {
  const interval = req.body.intervalMs || 5000;
  CONFIG.intervalMs = interval;

  if (CONFIG.autopollHandle) clearInterval(CONFIG.autopollHandle);

  CONFIG.autopoll = true;
  CONFIG.autopollHandle = setInterval(runPollingCycle, interval);

  res.json({
    success: true,
    message: "Autopolling started",
    intervalMs: interval
  });
});

app.post("/stop-autopoll", (req, res) => {
  CONFIG.autopoll = false;
  if (CONFIG.autopollHandle) clearInterval(CONFIG.autopollHandle);
  CONFIG.autopollHandle = null;

  res.json({ success: true, message: "Autopolling stopped" });
});

app.get("/autopoll-status", (req, res) => {
  res.json({
    autopolling: CONFIG.autopoll,
    intervalMs: CONFIG.intervalMs
  });
});

// ----------------------------------------------
// CONFIGURATION ENDPOINTS
// ----------------------------------------------
app.post("/set-goo-key", (req, res) => {
  CONFIG.gooKey = req.body.key;
  res.json({ success: true });
});

app.post("/set-goo-user", (req, res) => {
  CONFIG.gooUserId = req.body.userId;
  res.json({ success: true });
});

app.post("/set-openai-key", (req, res) => {
  CONFIG.openAIKey = req.body.key;
  res.json({ success: true });
});

// ----------------------------------------------
// STATUS
// ----------------------------------------------
app.get("/status", (req, res) => {
  res.json(CONFIG);
});

// ----------------------------------------------
// Render Port Binding
// ----------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
