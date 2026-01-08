-- Postgres schema for prototype

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pokemon (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  rarity TEXT NOT NULL,
  base_rate REAL NOT NULL CHECK (base_rate >= 0 AND base_rate <= 1)
);

CREATE TABLE IF NOT EXISTS spawns (
  id UUID PRIMARY KEY,
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  spawned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  captured_by TEXT REFERENCES users(id),
  capture_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_spawns_active ON spawns (spawned_at) WHERE (captured_by IS NULL);

CREATE TABLE IF NOT EXISTS pokedex (
  user_id TEXT NOT NULL REFERENCES users(id),
  pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
  count INTEGER NOT NULL DEFAULT 0,
  shiny_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, pokemon_id)
);

-- Simple key-value tokens table for storing OAuth tokens / other secrets
CREATE TABLE IF NOT EXISTS tokens (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
