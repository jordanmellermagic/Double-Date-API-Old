// server.js
// Double Date API - Final Clean Version

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANT: set this in your environment on Render or locally
// e.g. ADMIN_CODE=yourSecret123
const ADMIN_CODE = process.env.ADMIN_CODE || null;

app.use(express.json());

// Use global fetch if available (Node 18+), otherwise fall back to node-fetch
let fetchFn;
if (typeof global.fetch === 'function') {
  fetchFn = global.fetch.bind(global);
} else {
  fetchFn = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
}

// ========== In-memory user store ==========
//
// One entry per Goo ID (id).
//
// Shape:
// {
//   id: string,          // same as Goo ID, and URL segment
//   openaiKey: string,   // OpenAI API key for this user
//   locale: 'US' | 'INTL',
//
//   pollIntervalMs: number,
//   polling: boolean,
//   timerId: NodeJS.Timeout | null,
//
//   query: string | null,      // last processed Goo query
//   date: string | null,       // 'YYYY-MM-DD'
//   daysLived: number | null,  // number of days since date
//   weekday: string | null,    // 'Monday', etc
//   lastUpdated: string | null // ISO string
// }
const users = new Map();

// ========== Helpers ==========

// Simple admin guard for protected routes
function requireAdmin(req, res) {
  if (!ADMIN_CODE) {
    console.warn('WARNING: ADMIN_CODE is not set; admin protection is disabled!');
    return true; // allow everything if not configured
  }

  const headerCode = req.headers['x-admin-code'];
  const code = typeof headerCode === 'string' ? headerCode : null;

  if (!code || code !== ADMIN_CODE) {
    res.status(403).json({ error: 'Forbidden: invalid or missing admin code' });
    return false;
  }
  return true;
}

// Build Goo URL from user.id (Goo ID)
function buildGooURL(id) {
  return `https://11q.co/api/last/${encodeURIComponent(id)}`;
}

// Calculate days lived from a YYYY-MM-DD date string
function calculateDaysLived(dateStr) {
  if (!dateStr) return null;
  const birth = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(birth.getTime())) return null;

  const now = new Date();
  const diffMs = now.getTime() - birth.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return days;
}

// Calculate weekday name from YYYY-MM-DD (using UTC)
function calculateWeekday(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;

  const idx = d.getUTCDay(); // 0 = Sunday
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return names[idx] || null;
}

// Call OpenAI to extract YYYY-MM-DD from query text, honoring locale
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
Interpret all ambiguous numeric dates using **U.S. format** (MM/DD/YYYY).
Examples:
- 11/3/2008 → 2008-11-03
- 4/12/1999 → 1999-04-12
- 1/2/05 → 2005-01-02 (two-digit year also U.S. format)
`;
  } else {
    localeInstructions = `
Interpret all ambiguous numeric dates using **day-first international format** (DD/MM/YYYY).
Examples:
- 11/3/2008 → 2008-03-11
- 4/12/1999 → 1999-12-04
- 1/2/05 → 2005-02-01 (two-digit year also DD/MM/YY style)
`;
  }

  const prompt = `
Extract the date from the following text.

${localeInstructions.trim()}

Additional rules:
1. Do NOT change clearly written dates with month names (e.g. "March 6 2008" stays 2008-03-06).
2. Output ONLY the final date in ISO format: YYYY-MM-DD.
3. If the text contains no valid date, output exactly: null
4. Do NOT add explanations or any extra words.

Text: "${queryText}"
`.trim();

  try {
    const response = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a strict date-extraction tool.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`OpenAI error for user ${user.id}:`, response.status, text);
      return null;
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    content = content.trim();
    if (content.toLowerCase() === 'null') {
      return null;
    }

    // Strip code fences if present
    content = content.replace(/```[\s\S]*?```/g, ' ');
    content = content.replace(/`/g, ' ');

    const match = content.match(/\d{4}-\d{2}-\d{2}/);
    if (!match) {
      console.warn(`OpenAI returned unexpected format for user ${user.id}:`, content);
      return null;
    }

    return match[0];
  } catch (err) {
    console.error(`Error calling OpenAI for user ${user.id}:`, err);
    return null;
  }
}

// Poll Goo for a single user
async function pollUser(user) {
  const gooURL = buildGooURL(user.id);

  try {
    const res = await fetchFn(gooURL);
    if (!res.ok) {
      const text = await res.text();
      console.error(`Goo error for user ${user.id}:`, res.status, text);
      return;
    }

    const data = await res.json();
    const newQuery = data.query;

    if (typeof newQuery !== 'string') {
      console.warn(`User ${user.id}: Goo response did not contain a string "query"`, data);
      return;
    }

    // If query didn't change, no need to call OpenAI again
    if (user.query === newQuery) {
      return;
    }

    user.query = newQuery;
    console.log(`User ${user.id}: new query detected, sending to OpenAI.`);

    const date = await extractDateWithOpenAI(user, newQuery);
    if (!date) {
      console.warn(`User ${user.id}: could not extract date for query.`);
      return;
    }

    const days = calculateDaysLived(date);
    if (days === null) {
      console.warn(`User ${user.id}: failed to compute daysLived for date ${date}`);
      return;
    }

    const weekday = calculateWeekday(date);

    user.date = date;
    user.daysLived = days;
    user.weekday = weekday;
    user.lastUpdated = new Date().toISOString();

    console.log(`User ${user.id}: date=${date}, daysLived=${days}, weekday=${weekday}`);
  } catch (err) {
    console.error(`Error polling Goo for user ${user.id}:`, err);
  }
}

// Start polling loop for a user (every 2 seconds)
function startPolling(user) {
  if (user.polling && user.timerId) return;

  const interval = user.pollIntervalMs || 2000;
  user.pollIntervalMs = interval;
  user.polling = true;
  user.timerId = setInterval(() => {
    pollUser(user).catch(err => console.error('Poll error:', err));
  }, interval);

  console.log(`Started polling for user ${user.id} every ${interval}ms`);
}

// Stop polling loop for a user
function stopPolling(user) {
  if (user.timerId) {
    clearInterval(user.timerId);
    user.timerId = null;
  }
  user.polling = false;
  console.log(`Stopped polling for user ${user.id}`);
}

// Public-facing view of a user for /users list
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

// Health / info
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Double Date API is running. Admin: /admin, stats: /:id/stats'
  });
});

// ---------- Admin UI page ----------
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ---------- Admin API ----------

// Create user: body { id, openaiKey }, admin-only
app.post('/create', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { id, openaiKey } = req.body || {};

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'id (string, Goo ID) is required' });
  }
  if (!openaiKey || typeof openaiKey !== 'string') {
    return res.status(400).json({ error: 'openaiKey (string) is required' });
  }
  if (users.has(id)) {
    return res.status(400).json({ error: 'User with this id already exists' });
  }

  const user = {
    id,
    openaiKey,
    locale: 'US', // default locale
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

  res.status(201).json(publicUser(user));
});

// List users (admin)
app.get('/users', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const list = Array.from(users.values()).map(publicUser);
  res.json(list);
});

// Delete user (admin)
app.delete('/:id/delete', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { id } = req.params;
  const user = users.get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  stopPolling(user);
  users.delete(id);
  res.json({ ok: true });
});

// Force manual refresh for a user (admin)
app.post('/:id/refresh', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { id } = req.params;
  const user = users.get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  try {
    await pollUser(user);
    res.json(publicUser(user));
  } catch (err) {
    console.error('Manual refresh error:', err);
    res.status(500).json({ error: 'Error during manual refresh' });
  }
});

// Admin-only: update OpenAI key (and optionally locale) for a user
app.patch('/:id/admin-update', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { id } = req.params;
  const user = users.get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { openaiKey, locale } = req.body || {};

  if (openaiKey && typeof openaiKey === 'string') {
    user.openaiKey = openaiKey;
  }
  if (locale === 'US' || locale === 'INTL') {
    user.locale = locale;
  }

  res.json(publicUser(user));
});

// ---------- User-facing API ----------

// User-facing update: allow changing locale WITHOUT admin code
// PATCH /:id/update { locale: "US" | "INTL" }
app.patch('/:id/update', (req, res) => {
  const { id } = req.params;
  const user = users.get(id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { locale } = req.body || {};
  if (locale !== 'US' && locale !== 'INTL') {
    return res.status(400).json({ error: 'locale must be "US" or "INTL"' });
  }

  user.locale = locale;
  res.json({ id: user.id, locale: user.locale });
});

// Public stats endpoint: used by Hydra / Sensus / Show
// GET /:id/stats -> { daysLived: "6500", weekday: "Thursday" }
app.get('/:id/stats', (req, res) => {
  try {
    const { id } = req.params;
    const user = users.get(id);

    let daysStr = '0';
    let weekdayStr = '';

    if (!user) {
      console.warn(`Stats requested for missing user ${id}`);
    } else {
      if (typeof user.daysLived === 'number' && Number.isFinite(user.daysLived)) {
        daysStr = String(user.daysLived);
      }
      if (typeof user.weekday === 'string') {
        weekdayStr = user.weekday;
      }
    }

    res.set('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({
      daysLived: daysStr,
      weekday: weekdayStr
    }));
  } catch (err) {
    console.error('Stats endpoint error:', err);
    res.set('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({
      daysLived: '0',
      weekday: ''
    }));
  }
});

// ---------- Global error handler ----------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.set('Content-Type', 'application/json');
  res.status(500).json({ error: 'Internal server error' });
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`Double Date API listening on port ${PORT}`);
  console.log(`Admin UI: http://localhost:${PORT}/admin`);
  console.log(`Stats endpoint: http://localhost:${PORT}/<id>/stats`);
});
