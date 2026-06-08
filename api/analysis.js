'use strict';
// Vercel Serverless Function — endpoint JSON puro.
// Consulta o Supabase e retorna stats + análise de IA em cache.
// Não depende de servidor local nem de Ollama.

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

// ─── Stats query ──────────────────────────────────────────────────────────────

async function getStats(formA, formB) {
  const { rows } = await getPool().query(
    `WITH matchups AS (
       SELECT
         f.goals_home, f.goals_away,
         f.home_winner, f.away_winner,
         f.season,
         CASE WHEN lh.formation = $1 THEN 'home' ELSE 'away' END AS side_a
       FROM fixtures f
       JOIN fixture_lineups lh ON lh.fixture_id = f.id AND lh.team_id = f.home_team_id
       JOIN fixture_lineups la ON la.fixture_id = f.id AND la.team_id = f.away_team_id
       WHERE f.status = 'FT'
         AND (
           (lh.formation = $1 AND la.formation = $2) OR
           (lh.formation = $2 AND la.formation = $1)
         )
     )
     SELECT
       COUNT(*)::int                                             AS total,
       SUM(CASE
         WHEN side_a = 'home' AND home_winner = TRUE THEN 1
         WHEN side_a = 'away' AND away_winner = TRUE THEN 1
         ELSE 0 END)::int                                       AS wins_a,
       SUM(CASE
         WHEN side_a = 'home' AND away_winner = TRUE THEN 1
         WHEN side_a = 'away' AND home_winner = TRUE THEN 1
         ELSE 0 END)::int                                       AS wins_b,
       SUM(CASE
         WHEN home_winner IS NULL
          AND goals_home IS NOT NULL THEN 1
         ELSE 0 END)::int                                       AS draws,
       ROUND(AVG((goals_home + goals_away)::numeric), 1)        AS avg_goals,
       MIN(season)::int                                         AS min_season,
       MAX(season)::int                                         AS max_season
     FROM matchups`,
    [formA, formB],
  );

  const r = rows[0];
  if (!r?.total) return { formation_a: formA, formation_b: formB, total: 0 };

  const pct = (n) => parseFloat(((n / r.total) * 100).toFixed(1));
  return {
    formation_a:  formA,
    formation_b:  formB,
    total:        r.total,
    wins_a:       r.wins_a,
    wins_b:       r.wins_b,
    draws:        r.draws,
    pct_a:        pct(r.wins_a),
    pct_b:        pct(r.wins_b),
    pct_draw:     pct(r.draws),
    avg_goals:    parseFloat(r.avg_goals || 0),
    min_season:   r.min_season,
    max_season:   r.max_season,
  };
}

// ─── Cached AI analysis ───────────────────────────────────────────────────────

async function getCachedAnalysis(formA, formB) {
  const [a, b] = [formA, formB].sort();
  const { rows } = await getPool().query(
    `SELECT analysis_text FROM formation_analyses
     WHERE formation_a = $1 AND formation_b = $2`,
    [a, b],
  );
  return rows[0]?.analysis_text ?? null;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const { formation_a, formation_b } = req.query;

  if (!formation_a || !formation_b) {
    return res.status(400).json({ error: 'formation_a e formation_b são obrigatórios.' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const [stats, analysis] = await Promise.all([
      getStats(formation_a, formation_b),
      getCachedAnalysis(formation_a, formation_b),
    ]);

    res.json({ ...stats, analysis });
  } catch (err) {
    console.error('[api/analysis]', err.message);
    res.status(500).json({ error: err.message });
  }
};
