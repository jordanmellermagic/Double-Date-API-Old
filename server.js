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
 *   lastUpdated: string | null
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

// Helper: call OpenAI to extract date from query text
async function extractDateWithOpenAI(user, queryText) {
  const apiKey = user.openaiApiKey;
  if (!apiKey) {
    console.error(`No OpenAI API key configured for user ${user.userId}`);
    return null;
  }

  const prompt = `From the following text, extract the date and output it ONLY in the format yyyy-mm-dd.
If there is no clear date, output exactly the single word: null
Do not include any extra text.

Text: "${queryText}"`;

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

    // Store the latest raw query we saw
    user.lastQuery = newQuery;

    // Only process if the query actually changed
    if (newQuery === user.lastProcessedQuery) {
      return;
    }

    console.log(`User ${user.userId}: detected new query, sending to OpenAI.`);

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

// Helper: start polling for a user
function startPollingForUser(user) {
  if (user.polling && user.timerId) {
    return;
  }
  const interval = user.pollIntervalMs || 5000;
  user.polling = true;
  user.timerId = setInterval(() => {
    pollUser(user).catch(err => console.error('Poll error:', err));
  }, interval);
  console.log(`Started polling for user ${user.userId} every ${interval}ms`);
}

// Helper: stop polling for a user
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
    lastUpdated: user.lastUpdated
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

// Create a new user
app.post('/api/users', (req, res) => {
  const { userId, gooUserId, gooUrl, openaiApiKey, pollIntervalMs } = req.body || {};

  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId (string) is required' });
  }
  if (!openaiApiKey || typeof openaiApiKey !== 'string') {
    return res.status(400).json({ error: 'openaiApiKey (string) is required' });
  }
  if (!gooUserId && !gooUrl) {
    return res.status(400).json({ error: 'Either gooUserId or gooUrl is required' });
  }
  if (users.has(userId)) {
    return res.status(400).json({ error: 'User with this userId already exists' });
  }

  const finalGooUrl = gooUrl || buildGooUrl(gooUserId);
  const interval = typeof pollIntervalMs === 'number' && pollIntervalMs > 0 ? pollIntervalMs : 5000;

  const user = {
    userId,
    gooUserId: gooUserId || null,
    gooUrl: finalGooUrl,
    openaiApiKey,
    pollIntervalMs: interval,
    polling: false,
    timerId: null,
    lastQuery: null,
    lastProcessedQuery: null,
    formattedDate: null,
    daysLived: null,
    lastUpdated: null
  };

  users.set(userId, user);
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

    // Convert number → STRING (Hydra is happier with strings)
    const stringValue = String(numericValue);

    // Guaranteed small, valid JSON string
    res.set('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({ daysLived: stringValue }));

  } catch (err) {
    console.error('Hydra endpoint error:', err);

    // On ANY error, still return valid JSON with string value "0"
    res.set('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify({ daysLived: "0" }));
  }
});


// Update user config (goo / OpenAI / interval)
app.patch('/api/users/:userId', (req, res) => {
  const { userId } = req.params;
  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { gooUserId, gooUrl, openaiApiKey, pollIntervalMs } = req.body || {};

  if (gooUserId || gooUrl) {
    user.gooUserId = gooUserId || user.gooUserId;
    user.gooUrl = gooUrl || buildGooUrl(user.gooUserId);
  }

  if (openaiApiKey) {
    user.openaiApiKey = openaiApiKey;
  }

  if (typeof pollIntervalMs === 'number' && pollIntervalMs > 0) {
    user.pollIntervalMs = pollIntervalMs;

    if (user.polling) {
      stopPollingForUser(user);
      startPollingForUser(user);
    }
  }

  res.json(publicUser(user));
});

// Enable or disable polling for a user
app.post('/api/users/:userId/polling', (req, res) => {
  const { userId } = req.params;
  const user = users.get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }

  if (enabled) {
    startPollingForUser(user);
  } else {
    stopPollingForUser(user);
  }

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
