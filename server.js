// server.js
// Multi-user "days lived" API that polls Goo and uses OpenAI to extract dates.

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Use global fetch if available (Node 18+), otherwise fall back to node-fetch via dynamic import.
let fetchFn;
if (typeof global.fetch === 'function') {
  fetchFn = global.fetch.bind(global);
} else {
  fetchFn = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
}

// In-memory user store.
/**
 * User object shape:
 * {
 *   userId: string,
 *   gooUserId: string | null,
 *   gooUrl: string,
 *   openaiApiKey: string,
 *   pollIntervalMs: number,
 *   polling: boolean,
 *   timerId: NodeJS.Timeout | null,
 *   lastQuery: string | null,
 *   lastProcessedQuery: string | null,
 *   formattedDate: string | null,
 *   daysLived: number | null,
 *   lastUpdated: string | null,
 *   dateLocale: 'US' | 'INTL'
 * }
 */
const users = new Map();

// Helper: build Goo URL from Goo user id
function buildGooUrl(gooUserId) {
  return `https://11q.co/api/last/${gooUserId}`;
}

// Helper: calculate days lived from yyyy-mm-dd
function calculateDaysLived(formattedDate) {
  if (!formattedDate) return null;
  const birth = new Date(formattedDate + 'T00:00:00Z');
  if (isNaN(birth.getTime())) return null;

  const now = new Date();
  const diffMs = now.getTime() - birth.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return days;
}

// Helper: call OpenAI to extract date from query text (locale-aware)
async function extractDateWithOpenAI(user, queryText) {
  const apiKey = user.openaiApiKey;
  if (!apiKey) {
    console.error(`No OpenAI API key configured for user ${user.userId}`);
    return null;
  }

  const locale = user.dateLocale === 'INTL' ? 'INTL' : 'US';

  let localeInstructions;
  if (locale === 'US') {
    // US: MM/DD/YYYY
    localeInstructions = `
Interpret all ambiguous numeric dates using **U.S. format** (MM/DD/YYYY).
Examples:
- 11/3/2008 → 2008-11-03
- 4/12/1999 → 1999-04-12
- 1/2/05 → 2005-01-02 (two-digit year also U.S. format)
`;
  } else {
    // International: DD/MM/YYYY
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
        'Authorization': `Bearer ${apiKey}`,
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
      console.error(`OpenAI error for user ${user.userId}:`, response.status, text);
      return null;
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    content = content.trim();

    if (content.toLowerCase() === 'null') {
      return null;
    }

    // Strip code fences / backticks if present
    content = content.replace(/```[\s\S]*?```/g, ' ');
    content = content.replace(/`/g, ' ');

    // Look for ANY yyyy-mm-dd pattern in the content
    const match = content.match(/\d{4}-\d{2}-\d{2}/);
    if (!match) {
      console.warn(`OpenAI returned unexpected format for user ${user.userId}:`, content);
      return null;
    }

    const formatted = match[0];
    return formatted;
  } catch (err) {
    console.error(`Error calling OpenAI for user ${user.userId}:`, err);
    return null;
  }
}

// Helper: perform one poll cycle for a user
async function pollUser(user) {
  if (!user.gooUrl) {
    console.error(`User ${user.userId} has no gooUrl configured.`);
    return;
  }

  try {
    const res = await fetchFn(user.gooUrl);
    if (!res.ok) {
      const text = await res.text();
      console.error(`Goo API error for user ${user.userId}:`, res.status, text);
      return;
    }

    const data = await res.json();
    const newQuery = data.query;
    if (typeof newQuery !== 'string') {
      console.warn(`Goo API for user ${user.userId} returned no "query" string:`, data);
      return;
    }

    user.lastQuery = newQuery;

    // Only process if the query actually changed
    if (newQuery === user.lastProcessedQuery) {
      return;
    }

    console.log(`User ${user.userId}: detected new query, sending to OpenAI (locale=${user.dateLocale || 'US'}).`);

    const formatted = await extractDateWithOpenAI(user, newQuery);
    if (!formatted) {
      console.warn(`User ${user.userId}: could not extract formatted date from query.`);
      return;
    }

    const days = calculateDaysLived(formatted);
    if (days === null) {
      console.warn(`User ${user.userId}: failed to calculate days lived from ${formatted}`);
      return;
    }

    user.formattedDate = formatted;
    user.daysLived = days;
    user.lastProcessedQuery = newQuery;
    user.lastUpdated = new Date().toISOString();

    console.log(`User ${user.userId}: updated formattedDate=${formatted}, daysLived=${days}`);
  } catch (err) {
    console.error(`Error polling Goo for user ${user.userId}:`, err);
  }
}

// Helper: start polling for a user (always, no manual toggle; 2s interval)
function startPollingForUser(user) {
  if (user.polling && user.timerId) {
    return;
  }
  const interval = user.pollIntervalMs || 2000;
  user.polling = true;
  user.timerId = setInterval(() => {
    pollUser(user).catch(err => console.error('Poll error:', err));
  }, interval);
  console.log(`Started polling for user ${user.userId} every ${interval}ms`);
}

// Helper: stop polling (kept for internal use if needed)
function stopPollingForUser(user) {
  if (user.timerId) {
    clearInterval(user.timerId);
    user.timerId = null;
  }
  user.polling = false;
  console.log(`Stopped polling for user ${user.userId}`);
}

// Helper: sanitize user object for API responses (do not leak OpenAI key)
function publicUser(user) {
  return {
    userId: user.userId,
    gooUserId: user.gooUserId,
    gooUrl: user.gooUrl,
    pollIntervalMs: user.pollIntervalMs,
    polling: user.polling,
    lastQuery: user.lastQuery,
    lastProcessedQuery: user.lastProcessedQuery,
    formattedDate: user.formattedDate,
    daysLived: user.daysLived,
    lastUpdated: user.lastUpdated,
    dateLocale: user.dateLocale || 'US'
  };
}

// Routes

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Double Date API is running. Visit /docs for admin UI.' });
});

// Admin docs page
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'docs.html'));
});

// Create a new user (auto-poll ON, 2s interval)
app.post('/api/users', (req, res) => {
  const { userId, gooUserId, openaiApiKey, dateLocale } = req.body || {};

  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId (string) is required' });
  }
  if (!openaiApiKey || typeof openaiApiKey !== 'string') {
    return res.status(400).json({ error: 'openaiApiKey (string) is required' });
  }
  if (!gooUserId) {
    return res.status(400).json({ error: 'gooUserId is required' });
  }
  if (users.has(userId)) {
    return res.status(400).json({ error: 'User with this userId already exists' });
  }

  const finalGooUrl = buildGooUrl(gooUserId);
  const interval = 2000; // 2 seconds
  const locale = dateLocale === 'INTL' ? 'INTL' : 'US';

  const user = {
    userId,
    gooUserId,
    gooUrl: finalGooUrl,
    openaiApiKey,
    pollIntervalMs: interval,
    polling: false,
    timerId: null,
    lastQuery: null,
    lastProcessedQuery: null,
    formattedDate: null,
    daysLived: null,
    lastUpdated: null,
    dateLocale: locale
  };

  users.set(userId, user);
  startPollingForUser(user);

  res.status(201).json(publicUser(user));
});

// List all users
app.get('/api/users', (req, res) => {
  const list = Array.from(users.values()).map(publicUser);
  res.json(list);
});

// Get a single user (including daysLived)
app.get('/api/users/:userId', (req, res) => {
  const { userId } = req.params;
  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(publicUser(user));
});

// Delete a user
app.delete('/api/users/:userId', (req, res) => {
  const { userId } = req.params;
  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  stopPollingForUser(user);
  users.delete(userId);
  res.json({ ok: true });
});

// Ultra-safe Hydra endpoint: ALWAYS returns a STRING and NEVER errors
app.get('/api/users/:userId/days-lived', (req, res) => {
  try {
    const { userId } = req.params;
    const user = users.get(userId);

    let numericValue = 0;

    if (!user) {
      console.warn(`Hydra requested days-lived for missing user ${userId}`);
    } else if (typeof user.daysLived === 'number' && Number.isFinite(user.daysLived)) {
      numericValue = user.daysLived;
    }

    const stringValue = String(numericValue);

    res.set('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({ daysLived: stringValue }));
  } catch (err) {
    console.error('Hydra endpoint error:', err);
    res.set('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({ daysLived: "0" }));
  }
});

// Update user config (gooUserId, openaiApiKey, dateLocale)
app.patch('/api/users/:userId', (req, res) => {
  const { userId } = req.params;
  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { gooUserId, openaiApiKey, dateLocale } = req.body || {};

  if (gooUserId) {
    user.gooUserId = gooUserId;
    user.gooUrl = buildGooUrl(gooUserId);
  }

  if (openaiApiKey) {
    user.openaiApiKey = openaiApiKey;
  }

  if (dateLocale === 'US' || dateLocale === 'INTL') {
    user.dateLocale = dateLocale;
  }

  // Keep polling as-is (no toggles in UI)

  res.json(publicUser(user));
});

// Manually trigger one poll cycle for a user
app.post('/api/users/:userId/refresh', async (req, res) => {
  const { userId } = req.params;
  const user = users.get(userId);
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

// Global error handler – always JSON (never HTML)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.set('Content-Type', 'application/json');
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Double Date API listening on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT}/docs to manage users.`);
});
