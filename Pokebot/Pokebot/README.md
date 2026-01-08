# Kick Pokémon Bot (Node.js + Postgres) — Ready for Railway

Important security note
- Do NOT commit CLIENT_SECRET or any tokens. Use Railway Environment Variables. If a secret is exposed, rotate it immediately.

Overview
- Node.js bot implementing:
  - random spawns (single active spawn),
  - catch mechanics (atomic Postgres transactions),
  - Gen‑1 Pokémon seeded into DB,
  - shiny variants,
  - per-user cooldown,
  - leaderboard and pokedex endpoints,
  - Kick OAuth endpoints to obtain access_token (stored in DB),
  - Kick chat connector using a community wrapper with HTTP send fallback.

Files
- src/ — application source
  - server.js — Express server, OAuth routes, chat adapter, spawner
  - gameEngine.js — game engine, Gen‑1 seeding, spawn/catch logic
  - kickConnector.js — connector using community wrapper + HTTP send fallback
  - db.js — Postgres pool + migration runner
  - tokenManager.js — token refresh manager
- migrations/schema.sql — DB schema
- .env.example — example environment variables

Local setup
1. Copy `.env.example` to `.env` and fill values (DO NOT commit).
2. Install dependencies:
   - npm install
3. Start locally (ensure DATABASE_URL points to a Postgres instance):
   - npm start
4. Test chat commands using the HTTP chat stub:
   - POST /chat { "username":"alice", "message":"!catch" }
   - GET /leaderboard
   - GET /pokedex/alice

Railway deployment
1. Push repo to GitHub.
2. On Railway:
   - Create new project and link repo (or deploy from local).
   - Add a Postgres plugin and copy the provided DATABASE_URL.
   - Set Railway environment variables:
     - DATABASE_URL (from plugin)
     - CLIENT_ID (Kick client id)
     - CLIENT_SECRET (Kick client secret)
     - REDIRECT_URI (must match what you register on Kick Dev portal, e.g. https://your-app.up.railway.app/kick/callback)
     - KICK_CHANNEL (streamer username)
     - BOT_ADMIN_SECRET (random string)
     - Optional: SPAWN_MIN_INTERVAL, SPAWN_MAX_INTERVAL, SPAWN_DURATION, COOLDOWN_SECONDS, SHINY_RATE
3. Deploy — Railway will run `npm start`.
4. Authorize bot/account:
   - Visit `https://<your-app>/kick/auth` and complete Kick OAuth; tokens will be stored in the DB.
5. Monitor logs and test chat.

Next improvements you can request
- Add Pokémon sprites and richer messages.
- Harden the HTTP send path to match the current Kick endpoints if wrapper fails.
- Add a web dashboard or admin UI.
