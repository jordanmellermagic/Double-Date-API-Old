
# Double Date API

Multi-user "days lived" API that:

- Polls a Goo endpoint per user: `https://11q.co/api/last/{gooUserId}`
- Reads the `query` field
- Sends that query to OpenAI to extract a strict `yyyy-mm-dd` date
- Calculates `days_lived` from that date
- Exposes the result via simple JSON endpoints

## Quick start

```bash
npm install
npm start
```

The server will start on port `3000` by default.

Visit:

- `http://localhost:3000/docs` – simple admin UI
- `http://localhost:3000/api/users` – list users
- `http://localhost:3000/api/users/:userId` – see one user's state (including `daysLived`)

## Creating a user

Use the `/docs` UI or send a `POST`:

```http
POST /api/users
Content-Type: application/json

{
  "userId": "1",
  "gooUserId": "158",
  "openaiApiKey": "sk-...",
  "pollIntervalMs": 5000
}
```

You can also pass a full `gooUrl` instead of `gooUserId`:

```json
{
  "userId": "1",
  "gooUrl": "https://11q.co/api/last/158",
  "openaiApiKey": "sk-..."
}
```

## Turning polling on / off

```http
POST /api/users/1/polling
Content-Type: application/json

{ "enabled": true }
```

- `enabled: true` → start auto-polling for that user
- `enabled: false` → stop auto-polling (no Goo or OpenAI usage)

## Forcing a one-time refresh

```http
POST /api/users/1/refresh
```

This triggers a single poll + OpenAI pass for the user, regardless of polling state.

## Getting days lived

```http
GET /api/users/1
```

Response shape:

```json
{
  "userId": "1",
  "gooUserId": "158",
  "gooUrl": "https://11q.co/api/last/158",
  "pollIntervalMs": 5000,
  "polling": true,
  "lastQuery": "what day of the week was it on March 6 2008",
  "lastProcessedQuery": "what day of the week was it on March 6 2008",
  "formattedDate": "2008-03-06",
  "daysLived": 6490,
  "lastUpdated": "2025-12-09T00:00:00.000Z"
}
```

The important field for your Shortcut or other clients is:

- `daysLived` (number of days since the extracted date)
- optionally `formattedDate`

## Notes

- All user data is kept in memory (Map) in this starter; restart will clear it.
- You can later swap the in-memory store with a database if needed.
- OpenAI API key is stored per user and **never returned** via the public API.
