const axios = require('axios');

const ACCESS_KEY = 'kick:access_token';
const REFRESH_KEY = 'kick:refresh_token';
const ACCESS_EXPIRES_KEY = 'kick:access_expires_at'; // ISO timestamp

// How many milliseconds before expiry we attempt a refresh
const REFRESH_BEFORE_MS = 60 * 1000; // 60s

async function getTokenValue(pool, key) {
  const res = await pool.query(`SELECT value FROM tokens WHERE key = $1`, [key]);
  return res.rowCount ? res.rows[0].value : null;
}

async function setTokenValue(pool, key, value) {
  await pool.query(`INSERT INTO tokens (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}

// Refresh access token using refresh_token
async function refreshAccessToken(pool, clientId, clientSecret) {
  const refreshToken = await getTokenValue(pool, REFRESH_KEY);
  if (!refreshToken) {
    throw new Error('No refresh token available to refresh access token.');
  }
  if (!clientId || !clientSecret) {
    throw new Error('CLIENT_ID and CLIENT_SECRET are required to refresh token.');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);

  const resp = await axios.post('https://id.kick.com/oauth/token', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const data = resp.data;
  if (!data.access_token) throw new Error('Refresh response did not contain access_token.');

  // Store tokens and expiry
  await setTokenValue(pool, ACCESS_KEY, data.access_token);
  if (data.refresh_token) await setTokenValue(pool, REFRESH_KEY, data.refresh_token);

  if (data.expires_in) {
    const expiresAt = new Date(Date.now() + Number(data.expires_in) * 1000).toISOString();
    await setTokenValue(pool, ACCESS_EXPIRES_KEY, expiresAt);
  } else {
    // If server doesn't return expiry, set a conservative expiry (1 hour)
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    await setTokenValue(pool, ACCESS_EXPIRES_KEY, expiresAt);
  }

  return data.access_token;
}

// Ensure we have a valid access token. Refresh if missing or about to expire.
async function getValidAccessToken(pool, clientId, clientSecret) {
  const token = await getTokenValue(pool, ACCESS_KEY);
  const expiresAtStr = await getTokenValue(pool, ACCESS_EXPIRES_KEY);

  if (!token) {
    // no token; attempt refresh (if refresh_token exists)
    return refreshAccessToken(pool, clientId, clientSecret);
  }

  if (!expiresAtStr) {
    // no expiry info; be conservative and attempt refresh
    return refreshAccessToken(pool, clientId, clientSecret);
  }

  const expiresAt = new Date(expiresAtStr).getTime();
  const now = Date.now();
  if (expiresAt - now <= REFRESH_BEFORE_MS) {
    try {
      return await refreshAccessToken(pool, clientId, clientSecret);
    } catch (err) {
      console.warn('Token refresh failed, returning existing token:', err.message);
      return token;
    }
  }

  return token;
}

// Periodically check and refresh token proactively
function schedulePeriodicRefresh(pool, clientId, clientSecret, intervalMs = 60 * 1000) {
  const interval = setInterval(async () => {
    try {
      await getValidAccessToken(pool, clientId, clientSecret);
    } catch (err) {
      console.warn('Periodic token refresh failed:', err.message);
    }
  }, intervalMs);
  return () => clearInterval(interval);
}

module.exports = { getValidAccessToken, refreshAccessToken, schedulePeriodicRefresh, getTokenValue, setTokenValue };
