import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

let CONFIG = {
  docUrl: null,
  openAIKey: null,
  formatted_date: null,
  days_lived: null,
  last_raw_text: null,
};

// ----------------------------------------
// Helpers
// ----------------------------------------

function calculateDaysLived(dateString) {
  try {
    const date = new Date(dateString);
    const today = new Date();
    const diff = today - date;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  } catch (err) {
    return null;
  }
}

async function fetchGoogleDoc(url) {
  const res = await axios.get(url);
  return res.data;
}

async function getFormattedDateFromOpenAI(text, apiKey) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Extract a birthdate from text and return ONLY in YYYY-MM-DD format.",
        },
        { role: "user", content: text },
      ],
    },
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );

  return res.data.choices[0].message.content.trim();
}


// ----------------------------------------
// CORE ENDPOINT: Trigger Polling
// ----------------------------------------
app.post("/trigger", async (req, res) => {
  try {
    if (!CONFIG.docUrl) return res.status(400).json({ error: "No doc URL set." });
    if (!CONFIG.openAIKey) return res.status(400).json({ error: "No OpenAI key set." });

    // 1) Pull Google Doc text
    const text = await fetchGoogleDoc(CONFIG.docUrl);
    CONFIG.last_raw_text = text;

    // 2) Get formatted date from OpenAI
    const formatted = await getFormattedDateFromOpenAI(text, CONFIG.openAIKey);
    CONFIG.formatted_date = formatted;

    // 3) Calculate days lived
    CONFIG.days_lived = calculateDaysLived(formatted);

    return res.json({
      success: true,
      formatted_date: CONFIG.formatted_date,
      days_lived: CONFIG.days_lived,
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.toString() });
  }
});

// ----------------------------------------
// Setters
// ----------------------------------------

app.post("/set-doc-url", (req, res) => {
  CONFIG.docUrl = req.body.docUrl;
  res.json({ success: true, docUrl: CONFIG.docUrl });
});

app.post("/set-openai-key", (req, res) => {
  CONFIG.openAIKey = req.body.key;
  res.json({ success: true });
});

// ----------------------------------------
// Status
// ----------------------------------------

app.get("/status", (req, res) => {
  res.json({
    formatted_date: CONFIG.formatted_date,
    days_lived: CONFIG.days_lived,
    docUrl: CONFIG.docUrl,
    openAIKeySet: CONFIG.openAIKey != null,
    last_raw_text_snippet: CONFIG.last_raw_text
      ? CONFIG.last_raw_text.substring(0, 200)
      : null,
  });
});

// ----------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));

