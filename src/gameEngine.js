const { v4: uuidv4 } = require('uuid');

class GameEngine {
  constructor(dbPool, opts = {}) {
    this.pool = dbPool;
    this.spawnDuration = Number(opts.spawnDuration ?? 30);
    this.minInterval = Number(opts.minInterval ?? 30);
    this.maxInterval = Number(opts.maxInterval ?? 120);
    this.cooldownSeconds = Number(opts.cooldownSeconds ?? 5);
    this.shinyRate = Number(opts.shinyRate ?? (1/4096));
    this.cooldowns = new Map(); // userId -> lastAttemptTs (epoch ms)
    this._spawnerTimer = null;
    this.running = false;
  }

  async ensureSamplePokemon() {
    const res = await this.pool.query('SELECT count(1) AS c FROM pokemon');
    if (Number(res.rows[0].c) !== 0) return;

    // Rarity sets (tune as you like)
    const legendary = new Set(['Articuno','Zapdos','Moltres','Mewtwo','Mew']);
    const rare = new Set([
      'Dragonite','Lapras','Snorlax','Gyarados','Aerodactyl','Ditto','Alakazam','Gengar',
      'Machamp','Charizard','Blastoise','Venusaur','Onix','Rhydon','Exeggutor','Marowak',
      'Kingler','Cloyster','Starmie','Electabuzz','Magmar','Jynx','Scyther','Pinsir',
      'Tauros','Porygon','Omastar','Kabutops','Dragonair','Dratini'
    ]);
    const uncommon = new Set([
      'Pikachu','Eevee','Vaporeon','Jolteon','Flareon','Arcanine','Ninetales','Clefable',
      'Primeape','Poliwrath','Victreebel','Growlithe','Rapidash','Charmeleon','Wartortle','Ivysaur',
      'Golbat','Nidoqueen','Nidoking','Hypno','Mr. Mime',"Farfetch'd"
    ]);

    const baseRates = {
      common: 0.7,
      uncommon: 0.25,
      rare: 0.08,
      legendary: 0.01
    };

    const gen1 = [
      'Bulbasaur','Ivysaur','Venusaur','Charmander','Charmeleon','Charizard','Squirtle','Wartortle','Blastoise',
      'Caterpie','Metapod','Butterfree','Weedle','Kakuna','Beedrill','Pidgey','Pidgeotto','Pidgeot','Rattata','Raticate',
      'Spearow','Fearow','Ekans','Arbok','Pikachu','Raichu','Sandshrew','Sandslash','Nidoran♀','Nidorina','Nidoqueen',
      'Nidoran♂','Nidorino','Nidoking','Clefairy','Clefable','Vulpix','Ninetales','Jigglypuff','Wigglytuff','Zubat','Golbat',
      'Oddish','Gloom','Vileplume','Paras','Parasect','Venonat','Venomoth','Diglett','Dugtrio','Meowth','Persian',
      'Psyduck','Golduck','Mankey','Primeape','Growlithe','Arcanine','Poliwag','Poliwhirl','Poliwrath','Abra','Kadabra',
      'Alakazam','Machop','Machoke','Machamp','Bellsprout','Weepinbell','Victreebel','Tentacool','Tentacruel','Geodude',
      'Graveler','Golem','Ponyta','Rapidash','Slowpoke','Slowbro','Magnemite','Magneton',"Farfetch'd",'Doduo','Dodrio',
      'Seel','Dewgong','Grimer','Muk','Shellder','Cloyster','Gastly','Haunter','Gengar','Onix','Drowzee','Hypno','Krabby',
      'Kingler','Voltorb','Electrode','Exeggcute','Exeggutor','Cubone','Marowak','Hitmonlee','Hitmonchan','Lickitung','Koffing',
      'Weezing','Rhyhorn','Rhydon','Chansey','Tangela','Kangaskhan','Horsea','Seadra','Goldeen','Seaking','Staryu','Starmie',
      'Mr. Mime','Scyther','Jynx','Electabuzz','Magmar','Pinsir','Tauros','Magikarp','Gyarados','Lapras','Ditto','Eevee',
      'Vaporeon','Jolteon','Flareon','Porygon','Omanyte','Omastar','Kabuto','Kabutops','Aerodactyl','Snorlax','Articuno',
      'Zapdos','Moltres','Dratini','Dragonair','Dragonite','Mewtwo','Mew'
    ];

    console.log('Seeding Generation I Pokémon into the database...');
    for (const name of gen1) {
      let rarity = 'common';
      if (legendary.has(name)) rarity = 'legendary';
      else if (rare.has(name)) rarity = 'rare';
      else if (uncommon.has(name)) rarity = 'uncommon';
      const base_rate = baseRates[rarity];
      await this.pool.query(`INSERT INTO pokemon (name, rarity, base_rate) VALUES ($1, $2, $3)`, [name, rarity, base_rate]);
    }
    console.log('Gen I seed complete.');
  }

  async getActiveSpawn() {
    const now = new Date();
    const q = `
      SELECT s.id, s.pokemon_id, s.spawned_at, s.expires_at, p.name, p.rarity, p.base_rate
      FROM spawns s JOIN pokemon p ON s.pokemon_id = p.id
      WHERE s.captured_by IS NULL AND s.expires_at > $1
      ORDER BY s.spawned_at DESC
      LIMIT 1
    `;
    const res = await this.pool.query(q, [now.toISOString()]);
    return res.rows[0] ?? null;
  }

  async spawnOnce(pokemonId = null) {
    // Only spawn if no active spawn
    const existing = await this.getActiveSpawn();
    if (existing) return null;

    // pick a pokemon if not provided
    let pid = pokemonId;
    if (!pid) {
      const rows = (await this.pool.query('SELECT id, rarity FROM pokemon')).rows;
      if (rows.length === 0) return null;
      // simple rarity-weight pick
      const bucket = [];
      for (const r of rows) {
        let weight = { common: 1.0, uncommon: 0.6, rare: 0.2, legendary: 0.05 }[r.rarity] ?? 0.1;
        const times = Math.max(1, Math.round(weight * 100));
        for (let i = 0; i < times; i++) bucket.push(r.id);
      }
      pid = bucket[Math.floor(Math.random() * bucket.length)];
    }

    const id = uuidv4();
    const spawnedAt = new Date();
    const expiresAt = new Date(spawnedAt.getTime() + this.spawnDuration * 1000);

    await this.pool.query(
      `INSERT INTO spawns (id, pokemon_id, spawned_at, expires_at) VALUES ($1, $2, $3, $4)`,
      [id, pid, spawnedAt.toISOString(), expiresAt.toISOString()]
    );

    // return spawn info (fetch populated row)
    const res = await this.pool.query(`
      SELECT s.id, s.pokemon_id, s.spawned_at, s.expires_at, p.name, p.rarity, p.base_rate
      FROM spawns s JOIN pokemon p ON s.pokemon_id = p.id WHERE s.id = $1
    `, [id]);

    return res.rows[0];
  }

  async attemptCatch(userId, opts = {}) {
    // cooldown check (in-memory)
    const nowMs = Date.now();
    const last = this.cooldowns.get(userId) ?? 0;
    if (nowMs - last < (this.cooldownSeconds * 1000)) {
      return { ok: false, reason: 'cooldown' };
    }

    // attempt to catch active spawn within transaction and using FOR UPDATE
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const now = new Date();
      // lock active spawn row if present
      const spawnRes = await client.query(`
        SELECT s.id, s.pokemon_id, s.spawned_at, s.expires_at, p.name, p.base_rate
        FROM spawns s JOIN pokemon p ON s.pokemon_id = p.id
        WHERE s.captured_by IS NULL AND s.expires_at > $1
        ORDER BY s.spawned_at DESC
        LIMIT 1
        FOR UPDATE
      `, [now.toISOString()]);

      if (spawnRes.rowCount === 0) {
        await client.query('ROLLBACK');
        this.cooldowns.set(userId, nowMs);
        return { ok: false, reason: 'no_spawn' };
      }

      const spawn = spawnRes.rows[0];

      // compute catch chance (simple base_rate * ball modifier)
      const ball = opts.ball || 'pokeball';
      const ballMod = { pokeball: 1.0, greatball: 1.5, ultra: 2.0 }[ball] ?? 1.0;
      const catchChance = Math.min(0.99, spawn.base_rate * ballMod);

      const roll = Math.random();
      const isShiny = Math.random() < this.shinyRate;

      if (roll < catchChance) {
        // successful: update spawn captured_by, upsert user and pokedex
        const captureAt = new Date();
        await client.query(`UPDATE spawns SET captured_by = $1, capture_at = $2 WHERE id = $3`, [userId, captureAt.toISOString(), spawn.id]);

        // ensure user exists
        await client.query(`INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [userId, userId]);

        // upsert pokedex
        await client.query(`
          INSERT INTO pokedex (user_id, pokemon_id, count, shiny_count)
          VALUES ($1, $2, 1, $3)
          ON CONFLICT (user_id, pokemon_id) DO UPDATE
            SET count = pokedex.count + 1,
                shiny_count = pokedex.shiny_count + EXCLUDED.shiny_count
        `, [userId, spawn.pokemon_id, isShiny ? 1 : 0]);

        await client.query('COMMIT');
        this.cooldowns.set(userId, nowMs);
        return { ok: true, spawnId: spawn.id, pokemon: { id: spawn.pokemon_id, name: spawn.name }, shiny: isShiny };
      } else {
        // failed
        await client.query('ROLLBACK');
        this.cooldowns.set(userId, nowMs);
        return { ok: false, reason: 'failed', roll, catchChance };
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async leaderboard(limit = 10) {
    const res = await this.pool.query(`
      SELECT u.username AS user_id, COALESCE(SUM(pdx.count),0) AS total_caught, COALESCE(SUM(pdx.shiny_count),0) AS shiny_total
      FROM pokedex pdx
      JOIN users u ON pdx.user_id = u.id
      GROUP BY u.username
      ORDER BY total_caught DESC
      LIMIT $1
    `, [limit]);
    return res.rows;
  }

  async getPokedex(userId) {
    const res = await this.pool.query(`
      SELECT p.name, pd.count, pd.shiny_count
      FROM pokedex pd JOIN pokemon p ON pd.pokemon_id = p.id
      WHERE pd.user_id = $1
    `, [userId]);
    return res.rows;
  }

  startAutoSpawner(broadcastFn) {
    if (this.running) return;
    this.running = true;
    const scheduleNext = () => {
      const nextSec = Math.floor(Math.random() * (this.maxInterval - this.minInterval + 1)) + this.minInterval;
      this._spawnerTimer = setTimeout(async () => {
        try {
          const spawn = await this.spawnOnce();
          if (spawn && broadcastFn) {
            broadcastFn(spawn); // notify connector to send a chat message
          }
        } catch (err) {
          console.error('Spawner error', err);
        } finally {
          if (this.running) scheduleNext();
        }
      }, nextSec * 1000);
    };
    scheduleNext();
  }

  stopAutoSpawner() {
    this.running = false;
    if (this._spawnerTimer) clearTimeout(this._spawnerTimer);
    this._spawnerTimer = null;
  }
}

module.exports = GameEngine;
