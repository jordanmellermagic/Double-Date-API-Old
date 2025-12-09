import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// -------------------------------------------------------
// CONFIG — ONLY THESE 2 THINGS YOU MUST SET
// -------------------------------------------------------
let CONFIG = {
  gooUrl: null,        // ex: "https://11q.co/api/last/158"
  openAIKey: null,     // your OpenAI key

  last_query: null,
  last_hash: null,
  formatted_date: null,
  days_lived: null,

  autopoll: false,
  intervalMs: 5000,
  autopollHandle: null
};

// -------------------------------------------------------
// HELPERS
// -------------------------------------------------------
function calculateDaysLived(dateString) {
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return null;

  const today = new Date();
  return Math.floor((today - d) / (1000 * 60 * 60 * 24));
}

async function fetchFromGoo(url) {
  const res = await axios.get(url);
  return res.data;
}

async function askOpenAI(query, key) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Extract ANY date in the text and output ONLY YYYY-MM-DD. If no date exists, return NONE."
        },
        { role: "user", content: query }
      ]
    },
    { headers: { Authorization: `Bearer ${key}` } }
  );

  return res.data.choices[0].message.content.trim();
}

// -------------------------------------------------------
// CORE PROCESSING — ALWAYS RUNS WHEN CALLED
// -------------------------------------------------------
async function processQuery(queryText) {
  try {
    if (!CONFIG.openAIKey) {
      console.log("❌ No OpenAI key set.");
      return;
    }

    CONFIG.last_query = queryText;
    CONFIG.last_hash = JSON.stringify(queryText);

    console.log("🔄 Running OpenAI on:", queryText);

    const formatted = await askOpenAI(queryText, CONFIG.openAIKey);
    console.log("AI returned:", formatted);

    if (formatted === "NONE") {
      CONFIG.formatted_date = null;
      CONFIG.days_lived = null;
      return;
    }

    CONFIG.formatted_date = formatted;
    CONFIG.days_lived = calculateDaysLived(formatted);

    console.log("✅ Updated:", CONFIG.formatted_date, CONFIG.days_lived);

  } catch (err) {
    console.error("Processing error:", err.toString());
  }
}

// -------------------------------------------------------
// POLLING CYCLE — ONLY SKIPS IF query UNCHANGED
// -------------------------------------------------------
async function runPollingCycle() {
  try {
    const data = await fetchFromGoo(CONFIG.gooUrl);

    if (!("query" in data)) {
      console.log("❌ No 'query' field in GOO response.");
      return;
    }

    const newQuery = data.query;
    const hash = JSON.stringify(newQuery);

    if (CONFIG.last_hash === hash) {
      console.log("⏭️ No change.");
      return;
    }

    await processQuery(newQuery);

  } catch (err) {
    console.error("Polling error:", err.toString());
  }
}

// -------------------------------------------------------
// ENDPOINTS
// -------------------------------------------------------
app.post("/set-goo-url", (req, res) => {
  CONFIG.gooUrl = req.body.url;
  res.json({ success: true });
});

app.post("/set-openai-key", (req, res) => {
  CONFIG.openAIKey = req.body.key;
  res.json({ success: true });
});

app.post("/trigger", async (req, res) => {
  if (!CONFIG.gooUrl) return res.json({ error: "No gooUrl set" });

  const data = await fetchFromGoo(CONFIG.gooUrl);

  if (!data.query) return res.json({ error: "No query field" });

  await processQuery(data.query);

  res.json({
    last_query: CONFIG.last_query,
    formatted_date: CONFIG.formatted_date,
    days_lived: CONFIG.days_lived
  });
});

app.post("/start-autopoll", (req, res) => {
  CONFIG.intervalMs = req.body.intervalMs || 5000;

  if (CONFIG.autopollHandle)
    clearInterval(CONFIG.autopollHandle);

  CONFIG.autopoll = true;
  CONFIG.autopollHandle = setInterval(runPollingCycle, CONFIG.intervalMs);

  res.json({ success: true });
});

app.post("/stop-autopoll", (req, res) => {
  if (CONFIG.autopollHandle)
    clearInterval(CONFIG.autopollHandle);

  CONFIG.autopoll = false;
  CONFIG.autopollHandle = null;

  res.json({ success: true });
});

app.get("/status", (req, res) => {
  res.json({
    gooUrl: CONFIG.gooUrl,
    last_query: CONFIG.last_query,
    formatted_date: CONFIG.formatted_date,
    days_lived: CONFIG.days_lived,
    autopoll: CONFIG.autopoll,
    intervalMs: CONFIG.intervalMs
  });
});

// -------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
