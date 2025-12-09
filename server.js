import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Store config in memory
let CONFIG = {
  gooKey: null,
  gooUserId: null,
  openAIKey: null,

  last_value: null,
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

async function askOpenAI(rawText, key) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Extract a birthdate from this text and respond ONLY in YYYY-MM-DD format."
        },
        { role: "user", content: rawText }
      ]
    },
    {
      headers: { Authorization: `Bearer ${key}` }
    }
  );

  return res.data.choices[0].message.content.trim();
}

// ----------------------------------------------
// CORE: One processing cycle
// ----------------------------------------------
async function runProcessingCycle() {
  try {
    const { gooUserId, gooKey, openAIKey } = CONFIG;
    if (!gooUserId || !gooKey || !openAIKey) {
      console.log("Skipping cycle — missing configuration.");
      return;
    }

    // 1. Fetch from GOO
    const gooData = await fetchFromGoo(gooUserId, gooKey);
    CONFIG.last_value = gooData;

    // 2. Use OpenAI to extract date
    const formatted = await askOpenAI(JSON.stringify(gooData), openAIKey);
    CONFIG.formatted_date = formatted;

    // 3. Compute days lived
    CONFIG.days_lived = calculateDaysLived(formatted);

    console.log("Updated:", {
      formatted_date: formatted,
      days_lived: CONFIG.days_lived
    });

  } catch (err) {
    console.error("Cycle error:", err.toString());
  }
}

// ----------------------------------------------
// Manual trigger (single cycle)
// ----------------------------------------------
app.post("/trigger", async (req, res) => {
  await runProcessingCycle();
  res.json({
    formatted_date: CONFIG.formatted_date,
    days_lived: CONFIG.days_lived
  });
});

// ----------------------------------------------
// Autopoll controls
// ----------------------------------------------
app.post("/start-autopoll", (req, res) => {
  const interval = req.body.intervalMs || 5000;
  CONFIG.intervalMs = interval;

  if (CONFIG.autopollHandle) clearInterval(CONFIG.autopollHandle);

  CONFIG.autopoll = true;

  CONFIG.autopollHandle = setInterval(runProcessingCycle, interval);

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
// Configuration endpoints
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
// Status endpoint
// ----------------------------------------------
app.get("/status", (req, res) => {
  res.json(CONFIG);
});

// ----------------------------------------------
// Render Port Binding
// ----------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
