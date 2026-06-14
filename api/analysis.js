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

async function getStats(formA, formB, leagueIds = null, seasons = null) {
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
         AND ($3::int[] IS NULL OR f.league_id = ANY($3::int[]))
         AND ($4::int[] IS NULL OR f.season    = ANY($4::int[]))
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
    [formA, formB, leagueIds && leagueIds.length ? leagueIds : null, seasons && seasons.length ? seasons : null],
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

// ─── Modo "geral": formação contra todas as outras ───────────────────────────

async function getOverall(formation, leagueIds = null, seasons = null) {
  const { rows } = await getPool().query(
    `WITH matchups AS (
       SELECT
         f.season, f.goals_home, f.goals_away,
         f.home_winner, f.away_winner,
         CASE WHEN lh.formation = $1 THEN 'home' ELSE 'away' END AS side
       FROM fixtures f
       JOIN fixture_lineups lh ON lh.fixture_id = f.id AND lh.team_id = f.home_team_id
       JOIN fixture_lineups la ON la.fixture_id = f.id AND la.team_id = f.away_team_id
       WHERE f.status = 'FT'
         AND (lh.formation = $1 OR la.formation = $1)
         AND ($2::int[] IS NULL OR f.league_id = ANY($2::int[]))
         AND ($3::int[] IS NULL OR f.season    = ANY($3::int[]))
     )
     SELECT
       COUNT(*)::int                                            AS total,
       SUM(CASE
         WHEN side = 'home' AND home_winner = TRUE THEN 1
         WHEN side = 'away' AND away_winner = TRUE THEN 1
         ELSE 0 END)::int                                      AS wins,
       SUM(CASE
         WHEN side = 'home' AND away_winner = TRUE THEN 1
         WHEN side = 'away' AND home_winner = TRUE THEN 1
         ELSE 0 END)::int                                      AS losses,
       SUM(CASE
         WHEN home_winner IS NULL AND goals_home IS NOT NULL THEN 1
         ELSE 0 END)::int                                      AS draws,
       ROUND(AVG((goals_home + goals_away)::numeric), 1)       AS avg_goals,
       MIN(season)::int                                        AS min_season,
       MAX(season)::int                                        AS max_season
     FROM matchups`,
    [formation, leagueIds && leagueIds.length ? leagueIds : null, seasons && seasons.length ? seasons : null],
  );

  const r = rows[0];
  if (!r?.total) return { formation, total: 0, teams: [] };

  const pct = (n) => parseFloat(((n / r.total) * 100).toFixed(1));
  return {
    formation,
    total:      r.total,
    wins:       r.wins,
    draws:      r.draws,
    losses:     r.losses,
    pct_win:    pct(r.wins),
    pct_draw:   pct(r.draws),
    pct_loss:   pct(r.losses),
    avg_goals:  parseFloat(r.avg_goals || 0),
    min_season: r.min_season,
    max_season: r.max_season,
  };
}

async function getTopTeams(formation, limit = 10, leagueIds = null, seasons = null) {
  const { rows } = await getPool().query(
    `WITH team_games AS (
       SELECT
         fl.team_id,
         CASE WHEN fl.team_id = f.home_team_id THEN f.home_winner ELSE f.away_winner END AS won,
         f.home_winner, f.goals_home
       FROM fixture_lineups fl
       JOIN fixtures f ON f.id = fl.fixture_id
       WHERE fl.formation = $1
         AND f.status = 'FT'
         AND fl.team_id IN (f.home_team_id, f.away_team_id)
         AND ($3::int[] IS NULL OR f.league_id = ANY($3::int[]))
         AND ($4::int[] IS NULL OR f.season    = ANY($4::int[]))
     )
     SELECT
       t.id AS team_id, t.name AS name, t.logo_url AS logo_url,
       COUNT(*)::int                                         AS games,
       SUM(CASE WHEN tg.won = TRUE THEN 1 ELSE 0 END)::int   AS wins,
       SUM(CASE WHEN tg.home_winner IS NULL AND tg.goals_home IS NOT NULL THEN 1 ELSE 0 END)::int AS draws,
       SUM(CASE WHEN tg.won = FALSE THEN 1 ELSE 0 END)::int  AS losses
     FROM team_games tg
     JOIN teams t ON t.id = tg.team_id
     GROUP BY t.id, t.name, t.logo_url
     ORDER BY games DESC, wins DESC
     LIMIT $2`,
    [formation, limit, leagueIds && leagueIds.length ? leagueIds : null, seasons && seasons.length ? seasons : null],
  );

  return rows.map((r) => ({
    team_id:  parseInt(r.team_id),
    name:     r.name,
    logo_url: r.logo_url,
    games:    r.games,
    wins:     r.wins,
    draws:    r.draws,
    losses:   r.losses,
    pct_win:  r.games ? parseFloat(((r.wins / r.games) * 100).toFixed(1)) : 0,
  }));
}

// ─── Matchups por formação adversária (modo geral) ───────────────────────────

async function getMatchups(formation, leagueIds = null, seasons = null) {
  const { rows } = await getPool().query(
    `WITH matchups AS (
       SELECT
         CASE WHEN lh.formation = $1 THEN la.formation ELSE lh.formation END AS opp,
         CASE WHEN lh.formation = $1 THEN 'home' ELSE 'away' END             AS side,
         f.home_winner, f.away_winner, f.goals_home
       FROM fixtures f
       JOIN fixture_lineups lh ON lh.fixture_id = f.id AND lh.team_id = f.home_team_id
       JOIN fixture_lineups la ON la.fixture_id = f.id AND la.team_id = f.away_team_id
       WHERE f.status = 'FT'
         AND (lh.formation = $1 OR la.formation = $1)
         AND lh.formation <> la.formation
         AND ($2::int[] IS NULL OR f.league_id = ANY($2::int[]))
         AND ($3::int[] IS NULL OR f.season    = ANY($3::int[]))
     )
     SELECT
       opp                                                               AS opponent_formation,
       COUNT(*)::int                                                     AS total,
       SUM(CASE
         WHEN side = 'home' AND home_winner = TRUE THEN 1
         WHEN side = 'away' AND away_winner = TRUE THEN 1
         ELSE 0 END)::int                                                AS wins,
       SUM(CASE
         WHEN home_winner IS NULL AND goals_home IS NOT NULL THEN 1
         ELSE 0 END)::int                                                AS draws,
       SUM(CASE
         WHEN side = 'home' AND away_winner = TRUE THEN 1
         WHEN side = 'away' AND home_winner = TRUE THEN 1
         ELSE 0 END)::int                                                AS losses
     FROM matchups
     GROUP BY opp
     HAVING COUNT(*) >= 3
     ORDER BY
       SUM(CASE
         WHEN side = 'home' AND home_winner = TRUE THEN 1
         WHEN side = 'away' AND away_winner = TRUE THEN 1
         ELSE 0 END)::float / NULLIF(COUNT(*), 0) DESC,
       COUNT(*) DESC
     LIMIT 10`,
    [formation, leagueIds && leagueIds.length ? leagueIds : null, seasons && seasons.length ? seasons : null],
  );

  return rows.map((r) => ({
    opponent_formation: r.opponent_formation,
    total:   r.total,
    wins:    r.wins,
    draws:   r.draws,
    losses:  r.losses,
    pct_win: r.total ? parseFloat(((r.wins / r.total) * 100).toFixed(1)) : 0,
  }));
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

const isValidFormation = (f) => /^\d-\d(-\d){1,2}$/.test(f);
const parseLeagues = (v) => {
  if (!v) return null;
  const ids = String(v).split(',').map((s) => parseInt(s, 10)).filter(Number.isInteger);
  return ids.length ? ids : null;
};

const parseSeasons = (v) => {
  if (!v) return null;
  const years = String(v).split(',').map((s) => parseInt(s, 10)).filter(n => !isNaN(n));
  return years.length ? years : null;
};

module.exports = async (req, res) => {
  const { formation_a, formation_b } = req.query;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (!formation_a || !isValidFormation(formation_a)) {
    return res.status(400).json({ error: 'formation_a é obrigatória e deve ter o formato 4-3-3.' });
  }
  if (formation_b && !isValidFormation(formation_b)) {
    return res.status(400).json({ error: 'formation_b inválida — use o formato 4-3-3.' });
  }

  const leagues = parseLeagues(req.query.leagues);
  const seasons = parseSeasons(req.query.seasons);

  try {
    // Sem formation_b → modo "geral": a formação contra todas as outras + times que dominam.
    if (!formation_b) {
      const [overall, teams, matchups, analysis] = await Promise.all([
        getOverall(formation_a, leagues, seasons),
        getTopTeams(formation_a, 10, leagues, seasons),
        getMatchups(formation_a, leagues, seasons),
        getCachedAnalysis(formation_a, 'ALL'),
      ]);
      return res.json({ mode: 'overall', ...overall, teams, matchups, analysis });
    }

    const [stats, analysis] = await Promise.all([
      getStats(formation_a, formation_b, leagues, seasons),
      getCachedAnalysis(formation_a, formation_b),
    ]);

    res.json({ mode: 'matchup', ...stats, analysis });
  } catch (err) {
    console.error('[api/analysis]', err.message);
    res.status(500).json({ error: err.message });
  }
};
