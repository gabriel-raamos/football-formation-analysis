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
      `SELECT DISTINCT season::int AS season FROM fixtures WHERE status = 'FT' ORDER BY season DESC`,
    );
    res.json({ seasons: rows.map(r => r.season) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
