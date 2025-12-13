// server.js
// Double Date API – LA Timezone Version

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Set this in your environment (Render, local, etc)
const ADMIN_CODE = process.env.ADMIN_CODE || null;

app.use(express.json());

// Use global fetch if available (Node 18+), otherwise fall back to node-fetch
let fetchFn;
if (typeof global.fetch === 'function') {
  fetchFn = global.fetch.bind(global);
} else {
  fetchFn = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
}

// =========================================
// FORCE LOS ANGELES TIMEZONE FOR DATE MATH
// =========================================
function nowInLA() {
  // Convert LA time string → JS Date object
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
}

function birthInLA(dateStr) {
  // Birth date at LA local midnight
  return new Date(`${dateStr}T00:00:00-08:00`);
}

// ========== In-memory user store ==========
const users = new Map();

// ========== Helpers ==========

// Admin guard for protected routes
function requireAdmin(req, res) {
  if (!ADMIN_CODE) {
    console.warn('WARNING: ADMIN_CODE is not set; admin protection is disabled!');
    return true;
  }
  const headerCode = req.headers['x-admin-code'];
  const code = typeof headerCode === 'string' ? headerCode : null;
  if (!code || code !== ADMIN_CODE) {
    res.status(403).json({ error: 'Forbidden: invalid or missing admin code' });
    return false;
  }
  return true;
}

function buildGooURL(id) {
  return `https://11q.co/api/last/${encodeURIComponent(id)}`;
}

// =========================================
// DAYS LIVED — USING LOS ANGELES TIMEZONE
// =========================================
function calculateDaysLived(dateStr) {
  if (!dateStr) return null;

  const birth = birthInLA(dateStr);
  if (isNaN(birth)) return null;

  const now = nowInLA();

  const diffMs = now.getTime() - birth.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  return days;
}

// =========================================
// WEEKDAY — USING LOS ANGELES TIMEZONE
// =========================================
function calculateWeekday(dateStr) {
  if (!dateStr) return null;

  const d = birthInLA(dateStr);
  if (isNaN(d)) return null;

  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return names[d.getDay()];
}

// ========== OpenAI Date Extraction ==========
async function extractDateWithOpenAI(user, queryText) {
  const key = user.openaiKey;
  if (!key) {
    console.error(`User ${user.id}: missing OpenAI key`);
    return null;
  }

  const locale = user.locale === 'INTL' ? 'INTL' : 'US';
  let localeInstructions;

  if (locale === 'US') {
    localeInstructions = `
Interpret ALL numeric dates using strictly U.S. format (MM/DD/YYYY).

Rules:
1. The first number is always the MONTH.
2. The second number is always the DAY.
3. The third number is always the YEAR.
4. NEVER reinterpret or reorder the numbers.
`.trim();
  } else {
    localeInstructions = `
Interpret ALL numeric dates using strictly international DD/MM/YYYY.

Rules:
1. First number = DAY.
2. Second number = MONTH.
3. Third number = YEAR.
4. NEVER reinterpret or reorder the numbers.
`.trim();
  }

  const prompt = `
Extract the date from the text.

${localeInstructions}

- Output ONLY YYYY-MM-DD
- Or output: null
- No explanations.

Text: "${queryText}"
`.trim();

  try {
    const response = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: "You are a strict date-extraction tool." },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenAI error:", text);
      return null;
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    if (content.toLowerCase() === "null") return null;

    const match = content.match(/\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : null;
  } catch (err) {
    console.error("OpenAI Error:", err);
    return null;
  }
}

// ========== Poll Goo ==========
async function pollUser(user) {
  const gooURL = buildGooURL(user.id);

  try {
    const res = await fetchFn(gooURL);
    if (!res.ok) {
      const text = await res.text();
      console.error("Goo error:", res.status, text);
      return;
    }

    const data = await res.json();
    const newQuery = data.query;

    if (typeof newQuery !== "string") return;

    if (user.query === newQuery) return;

    user.query = newQuery;

    const date = await extractDateWithOpenAI(user, newQuery);
    if (!date) return;

    user.date = date;
    user.daysLived = calculateDaysLived(date);
    user.weekday = calculateWeekday(date);
    user.lastUpdated = nowInLA().toISOString();
  } catch (err) {
    console.error("Poll error:", err);
  }
}

function startPolling(user) {
  if (user.polling && user.timerId) return;

  const interval = user.pollIntervalMs || 2000;
  user.pollIntervalMs = interval;
  user.polling = true;

  user.timerId = setInterval(() => {
    pollUser(user).catch(console.error);
  }, interval);
}

function stopPolling(user) {
  if (user.timerId) clearInterval(user.timerId);
  user.timerId = null;
  user.polling = false;
}

// ========== Public user view ==========
function publicUser(user) {
  return {
    id: user.id,
    locale: user.locale,
    query: user.query,
    date: user.date,
    daysLived: user.daysLived,
    weekday: user.weekday,
    lastUpdated: user.lastUpdated
  };
}

// ========== Routes ==========

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Double Date API with LA timezone' });
});

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ----- Admin API -----
app.post('/create', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { id, openaiKey } = req.body;
  if (!id || !openaiKey) return res.status(400).json({ error: 'id + openaiKey required' });

  if (users.has(id)) return res.status(400).json({ error: 'Exists' });

  const user = {
    id,
    openaiKey,
    locale: 'US',
    pollIntervalMs: 2000,
    polling: false,
    timerId: null,
    query: null,
    date: null,
    daysLived: null,
    weekday: null,
    lastUpdated: null
  };

  users.set(id, user);
  startPolling(user);

  res.json(publicUser(user));
});

app.get('/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(Array.from(users.values()).map(publicUser));
});

app.delete('/:id/delete', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  stopPolling(user);
  users.delete(req.params.id);
  res.json({ ok: true });
});

app.post('/:id/refresh', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });

  await pollUser(user);
  res.json(publicUser(user));
});

app.patch('/:id/admin-update', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const { openaiKey, locale } = req.body;

  if (openaiKey) user.openaiKey = openaiKey;
  if (locale === 'US' || locale === 'INTL') user.locale = locale;

  res.json(publicUser(user));
});

// ----- User-facing API -----
app.patch('/:id/update', (req, res) => {
  const { locale } = req.body;
  const user = users.get(req.params.id);

  if (!user) return res.status(404).json({ error: 'Not found' });
  if (locale !== 'US' && locale !== 'INTL')
    return res.status(400).json({ error: 'Invalid locale' });

  user.locale = locale;
  res.json({ id: user.id, locale });
});

// Stats
app.get('/:id/stats', (req, res) => {
  const user = users.get(req.params.id);

  const result = {
    daysLived: user?.daysLived != null ? String(user.daysLived) : "0",
    weekday: user?.weekday || ""
  };

  res.json(result);
});

// ----- Error handler -----
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ----- Start server -----
app.listen(PORT, () => {
  console.log(`Double Date API listening on port ${PORT}`);
});
