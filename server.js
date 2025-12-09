import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Store config in memory
let CONFIG = {
  gooKey: null,
  gooUserId: null,  // ex: 158
  last_value: null,
  formatted_date: null,
  days_lived: null
};

// -----------------------------
// Helpers
// -----------------------------

// Compute days lived
function calculateDaysLived(dateString) {
  const d = new Date(dateString);
  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

// Hit GOO endpoint
async function fetchFromGoo(userId, apiKey) {
  const url = `https://11q.co/api/last/${userId}?key=${apiKey}`;
  const res = await axios.get(url);
  return res.data;  // GOO returns JSON
}

// Ask OpenAI to extract a formatted YYYY-MM-DD date
async function askOpenAI(rawText, openAIKey) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Extract a birthdate from this text and respond ONLY in YYYY-MM-DD format."
        },
        {
          role: "user",
          content: rawText
        }
      ]
    },
    {
      headers: { Authorization: `Bearer ${openAIKey}` }
    }
  );

  return res.data.choices[0].message.content.trim();
}

// -----------------------------
// MAIN ACTION: trigger polling
// -----------------------------
app.post("/trigger", async (req, res) => {
  try {
    const { gooUserId, gooKey, openAIKey } = CONFIG;

    if (!gooUserId || !gooKey) {
      return res.status(400).json({ error: "Set gooUserId and gooKey first." });
    }
    if (!openAIKey) {
      return res.status(400).json({ error: "Set OpenAI key first." });
    }

    // 1. Fetch from GOO
    const gooData = await fetchFromGoo(gooUserId, gooKey);
    CONFIG.last_value = gooData;

    // 2. Send gooData.text to OpenAI
    const formatted = await askOpenAI(JSON.stringify(gooData), openAIKey);
    CONFIG.formatted_date = formatted;

    // 3. Compute days lived
    CONFIG.days_lived = calculateDaysLived(formatted);

    res.json({
      success: true,
      goo_value: gooData,
      formatted_date: formatted,
      days_lived: CONFIG.days_lived
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.toString() });
  }
});

// -----------------------------
// Configuration endpoints
// -----------------------------
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

// -----------------------------
// Status
// -----------------------------
app.get("/status", (req, res) => {
  res.json(CONFIG);
});

// -----------------------------
// Render Port Fix
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
