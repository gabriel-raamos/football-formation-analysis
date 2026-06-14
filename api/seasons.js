'use strict';
const { Pool } = require('pg');

let _pool;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 1,
    });
  }
  return _pool;
}

module.exports = async (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  try {
    const { rows } = await getPool().query(
      `SELECT season::int AS season, COUNT(DISTINCT id)::int AS games
       FROM fixtures WHERE status = 'FT'
       GROUP BY season ORDER BY season DESC`,
    );
    res.json({ seasons: rows.map(r => ({ season: r.season, games: parseInt(r.games) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
