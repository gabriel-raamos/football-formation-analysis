'use strict';
// Vercel Serverless Function — campeonatos conhecidos + contagem de jogos com
// escalação. Alimenta o filtro de ligas no frontend (mesmo contrato do servidor
// local /api/leagues).

const { Pool } = require('pg');
const { LEAGUES } = require('../leagues');

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
  res.setHeader('Cache-Control', 'no-store');

  try {
    const { rows } = await getPool().query(
      `SELECT f.league_id, COUNT(DISTINCT f.id)::int AS games
         FROM fixtures f
         JOIN fixture_lineups fl ON fl.fixture_id = f.id
        WHERE f.status = 'FT'
        GROUP BY f.league_id`,
    );
    const counts = new Map(rows.map((r) => [parseInt(r.league_id), r.games]));
    res.json(LEAGUES.map((l) => ({ ...l, games: counts.get(l.id) || 0 })));
  } catch (err) {
    console.error('[api/leagues]', err.message);
    res.status(500).json({ error: err.message });
  }
};
