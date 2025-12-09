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
  try {
    const d = new Date(dateString);
    const now = new Date();
    return Math.floor((now - d) / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

async function fetchFromGoo(userId, apiKey) {
  const url = `https://11q.co/api/last/${userId}?key=${apiKey}`;
  const res = await axios.get(url);
  return res.data;
}

function simpleHash(obj) {
  return JSON.stringify(obj);
}

// -------------------------------------------------------------------------
// UPDATED OpenAI CALL — Extract ANY date from text, or return NONE
// -------------------------------------------------------------------------
async function askOpenAI(rawText, key) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Extract ANY date found in the text below and output it ONLY in YYYY-MM-DD format. If no date exists, return the string NONE."
        },
        { role: "user", content: rawText }
      ]
    },
    { headers: { Authorization: `Bearer ${key}` } }
  );

  return res.data.choices[0].message.content.trim();
}

// -------------------------------------------------------------------------
// CORE CHANGE-DETECTION POLLING LOOP
// -------------------------------------------------------------------------
async function runPollingCycle() {
  try {
    const { gooUserId, gooKey, openAIKey } = CONFIG;

    if (!gooUserId || !gooKey || !openAIKey) {
      console.log("Polling skipped — missing configuration.");
      return;
    }

    // Get latest GOO value
    const gooData = await fetchFromGoo(gooUserId, gooKey);
    const newHash = simpleHash(gooData);

    // Check for change
    if (newHash !== CONFIG.last_hash) {
      console.log("🔄 GOO data changed — processing…");

      CONFIG.last_hash = newHash;
      CONFIG.last_value = gooData;

      // Send to OpenAI
      const formatted = await askOpenAI(JSON.stringify(gooData), openAIKey);
      console.log("AI Returned:", formatted);

      if (formatted === "NONE") {
        console.log("⚠️ No date found in message — skipping update.");
        CONFIG.formatted_date = null;
        CONFIG.days_lived = null;
        return;
      }

      CONFIG.formatted_date = formatted;
      CONFIG.days_lived = calculateDaysLived(formatted);

      console.log("✅ Updated:", {
        formatted_date: CONFIG.formatted_date,
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
// Manual single-cycle trigger
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
// SAFE STATUS ENDPOINT — avoids sending the timer object
// ----------------------------------------------
app.get("/status", (req, res) => {
  const safeConfig = { ...CONFIG };
  safeConfig.autopollHandle = CONFIG.autopollHandle ? "RUNNING" : "STOPPED";
  res.json(safeConfig);
});

// ----------------------------------------------
// Render Port Binding
// ----------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
