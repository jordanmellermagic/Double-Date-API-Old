import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ------------------------------------------------------------------
// CONFIG STORAGE (only two real things you need to set)
// ------------------------------------------------------------------
let CONFIG = {
  gooUrl: null,        // Example: "https://11q.co/api/158"
  openAIKey: null,     // Your OpenAI API key

  last_query: null,
  last_hash: null,
  formatted_date: null,
  days_lived: null,

  autopoll: false,
  intervalMs: 5000,
  autopollHandle: null
};

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------
function calculateDaysLived(dateString) {
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return null;

  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

function simpleHash(text) {
  return JSON.stringify(text);
}

async function fetchFromGoo(url) {
  const res = await axios.get(url);
  return res.data;
}

async function askOpenAI(text, key) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Extract ANY date found in the text below and output ONLY YYYY-MM-DD. If no date exists, return NONE."
        },
        { role: "user", content: text }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${key}`
      }
    }
  );

  return res.data.choices[0].message.content.trim();
}

// ------------------------------------------------------------------
// MAIN PROCESSING CYCLE
// ------------------------------------------------------------------
async function runProcessingCycle() {
  try {
    if (!CONFIG.gooUrl || !CONFIG.openAIKey) {
      console.log("Skipping — missing gooUrl or OpenAI key.");
      return;
    }

    const gooData = await fetchFromGoo(CONFIG.gooUrl);

    if (!gooData.query) {
      console.log("No 'query' field found in GOO response.");
      return;
    }

    const queryText = gooData.query;
    const newHash = simpleHash(queryText);

    if (newHash === CONFIG.last_hash) {
      console.log("No new query.");
      return;
    }

    CONFIG.last_hash = newHash;
    CONFIG.last_query = queryText;

    console.log("🔄 New query:", queryText);

    const formatted = await askOpenAI(queryText, CONFIG.openAIKey);

    if (formatted === "NONE") {
      CONFIG.formatted_date = null;
      CONFIG.days_lived = null;
      console.log("⚠️ No date found.");
      return;
    }

    CONFIG.formatted_date = formatted;
    CONFIG.days_lived = calculateDaysLived(formatted);

    console.log("✅ Updated:", {
      formatted_date: CONFIG.formatted_date,
      days_lived: CONFIG.days_lived
    });

  } catch (err) {
    console.error("Processing error:", err.toString());
  }
}

// ------------------------------------------------------------------
// ENDPOINTS YOU WILL USE
// ------------------------------------------------------------------

// 1) Set the GOO URL (example: https://11q.co/api/158)
app.post("/set-goo-url", (req, res) => {
  CONFIG.gooUrl = req.body.url;
  res.json({ success: true, gooUrl: CONFIG.gooUrl });
});

// 2) Set OpenAI KEY
app.post("/set-openai-key", (req, res) => {
  CONFIG.openAIKey = req.body.key;
  res.json({ success: true });
});

// 3) Start autopoll
app.post("/start-autopoll", (req, res) => {
  CONFIG.intervalMs = req.body.intervalMs || 5000;

  if (CONFIG.autopollHandle)
    clearInterval(CONFIG.autopollHandle);

  CONFIG.autopoll = true;
  CONFIG.autopollHandle = setInterval(runProcessingCycle, CONFIG.intervalMs);

  res.json({ success: true, intervalMs: CONFIG.intervalMs });
});

// 4) Stop autopoll
app.post("/stop-autopoll", (req, res) => {
  if (CONFIG.autopollHandle)
    clearInterval(CONFIG.autopollHandle);

  CONFIG.autopoll = false;
  CONFIG.autopollHandle = null;

  res.json({ success: true });
});

// 5) Manually trigger one cycle
app.post("/trigger", async (req, res) => {
  await runProcessingCycle();
  res.json({
    last_query: CONFIG.last_query,
    formatted_date: CONFIG.formatted_date,
    days_lived: CONFIG.days_lived
  });
});

// 6) Status
app.get("/status", (req, res) => {
  res.json({
    gooUrl: CONFIG.gooUrl,
    last_query: CONFIG.last_query,
    formatted_date: CONFIG.formatted_date,
    days_lived: CONFIG.days_lived,
    autopoll: CONFIG.autopoll,
    intervalMs: CONFIG.intervalMs,
    autopollHandle: CONFIG.autopollHandle ? "RUNNING" : "STOPPED"
  });
});

// ------------------------------------------------------------------
// SERVER BINDING
// ------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
