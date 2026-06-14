'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const { LEAGUES } = require('./leagues');

// ─── Connection pool ──────────────────────────────────────────────────────────
// Supabase usa TLS obrigatório; rejectUnauthorized:false aceita o certificado
// sem precisar do bundle de CA local.

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[db] conexão ociosa com erro:', err.message);
});

// ─── Query helpers ────────────────────────────────────────────────────────────

/**
 * Retorna partidas onde (homeFormation == A e awayFormation == B) ou vice-versa.
 * Retorna resultado instantaneamente a partir do banco.
 *
 * @param {number} season
 * @param {string} formationA
 * @param {string} formationB
 * @returns {Promise<object[]>}
 */
async function searchByFormations(season, formationA, formationB) {
  const { rows } = await pool.query(
    `SELECT
       f.id,
       f.date_utc,
       f.round,
       f.season,
       f.goals_home,
       f.goals_away,
       f.home_winner,
       f.away_winner,
       v.name          AS venue_name,
       th.id           AS home_id,
       th.name         AS home_name,
       th.logo_url     AS home_logo,
       ta.id           AS away_id,
       ta.name         AS away_name,
       ta.logo_url     AS away_logo,
       lh.formation    AS home_formation,
       la.formation    AS away_formation
     FROM fixtures f
     JOIN fixture_lineups lh ON lh.fixture_id = f.id AND lh.team_id = f.home_team_id
     JOIN fixture_lineups la ON la.fixture_id = f.id AND la.team_id = f.away_team_id
     JOIN teams th ON th.id = f.home_team_id
     JOIN teams ta ON ta.id = f.away_team_id
     LEFT JOIN venues v ON v.id = f.venue_id
     WHERE f.season = $1
       AND f.status = 'FT'
       AND (
         (lh.formation = $2 AND la.formation = $3) OR
         (lh.formation = $3 AND la.formation = $2)
       )
     ORDER BY f.date_utc`,
    [season, formationA, formationB],
  );
  return rows;
}

/**
 * Retorna ids de partidas de uma temporada que ainda não têm lineup registrado
 * para ambos os times.
 *
 * @param {number} season
 * @returns {Promise<{ id: number, home_team_id: number, away_team_id: number }[]>}
 */
async function getFixturesWithoutLineups(season) {
  const { rows } = await pool.query(
    `SELECT f.id, f.home_team_id, f.away_team_id
     FROM fixtures f
     WHERE f.season = $1
       AND NOT EXISTS (
         SELECT 1 FROM fixture_lineups fl
         WHERE fl.fixture_id = f.id
           AND fl.team_id IN (f.home_team_id, f.away_team_id)
       )
     ORDER BY f.id`,
    [season],
  );
  return rows;
}

/**
 * Insere ou ignora formações de escalação de uma partida.
 *
 * @param {number} fixtureId
 * @param {{ [teamId: string]: string }} lineupMap   e.g. { "127": "4-3-3", "131": "4-2-3-1" }
 */
async function saveLineups(fixtureId, lineupMap) {
  const entries = Object.entries(lineupMap).filter(([, f]) => !!f);
  if (!entries.length) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [teamId, formation] of entries) {
      await client.query(
        `INSERT INTO fixture_lineups (fixture_id, team_id, formation)
         VALUES ($1, $2, $3)
         ON CONFLICT (fixture_id, team_id) DO NOTHING`,
        [fixtureId, parseInt(teamId), formation],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Contagem de registros por tabela — útil para verificar saúde do banco.
 *
 * @returns {Promise<{ fixtures: number, lineups: number, teams: number, venues: number }>}
 */
async function getStats() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM fixtures)        AS fixtures,
      (SELECT COUNT(*) FROM fixture_lineups) AS lineups,
      (SELECT COUNT(*) FROM teams)           AS teams,
      (SELECT COUNT(*) FROM venues)          AS venues
  `);
  return {
    fixtures: parseInt(rows[0].fixtures),
    lineups:  parseInt(rows[0].lineups),
    teams:    parseInt(rows[0].teams),
    venues:   parseInt(rows[0].venues),
  };
}

/**
 * Retorna estatísticas agregadas e metadados de um confronto entre duas formações.
 * Considera TODAS as temporadas disponíveis no banco.
 *
 * @param {string} formationA
 * @param {string} formationB
 * @returns {Promise<{
 *   formation_a: string, formation_b: string,
 *   total: number, wins_a: number, wins_b: number, draws: number,
 *   pct_a: number, pct_b: number, pct_draw: number,
 *   avg_goals: number, min_season: number, max_season: number
 * }>}
 */
async function getFormationStats(formationA, formationB, leagueIds = null, seasons = null) {
  const { rows } = await pool.query(
    `WITH matchups AS (
       SELECT
         f.id,
         f.season,
         f.goals_home,
         f.goals_away,
         f.home_winner,
         f.away_winner,
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
       COUNT(*)::int                                               AS total,
       SUM(CASE
         WHEN side_a = 'home' AND home_winner = TRUE  THEN 1
         WHEN side_a = 'away' AND away_winner = TRUE  THEN 1
         ELSE 0 END)::int                                         AS wins_a,
       SUM(CASE
         WHEN side_a = 'home' AND away_winner = TRUE  THEN 1
         WHEN side_a = 'away' AND home_winner = TRUE  THEN 1
         ELSE 0 END)::int                                         AS wins_b,
       SUM(CASE
         WHEN home_winner IS NULL
          AND goals_home  IS NOT NULL THEN 1
         ELSE 0 END)::int                                         AS draws,
       ROUND(AVG((goals_home + goals_away)::numeric), 1)          AS avg_goals,
       MIN(season)::int                                           AS min_season,
       MAX(season)::int                                           AS max_season
     FROM matchups`,
    [formationA, formationB, leagueIds && leagueIds.length ? leagueIds : null, seasons && seasons.length ? seasons : null],
  );

  const r = rows[0];
  if (!r || !r.total) {
    return {
      formation_a: formationA, formation_b: formationB,
      total: 0, wins_a: 0, wins_b: 0, draws: 0,
      pct_a: 0, pct_b: 0, pct_draw: 0,
      avg_goals: 0, min_season: null, max_season: null,
    };
  }

  const pct = (n) => parseFloat(((n / r.total) * 100).toFixed(1));

  return {
    formation_a:  formationA,
    formation_b:  formationB,
    total:        r.total,
    wins_a:       r.wins_a,
    wins_b:       r.wins_b,
    draws:        r.draws,
    pct_a:        pct(r.wins_a),
    pct_b:        pct(r.wins_b),
    pct_draw:     pct(r.draws),
    avg_goals:    parseFloat(r.avg_goals ?? 0),
    min_season:   r.min_season,
    max_season:   r.max_season,
  };
}

/**
 * Estatísticas de uma formação contra TODAS as outras (modo "geral").
 * Considera TODAS as temporadas disponíveis no banco.
 *
 * @param {string} formation
 * @returns {Promise<{
 *   formation: string, total: number,
 *   wins: number, draws: number, losses: number,
 *   pct_win: number, pct_draw: number, pct_loss: number,
 *   avg_goals: number, min_season: number, max_season: number
 * }>}
 */
async function getFormationOverall(formation, leagueIds = null, seasons = null) {
  const { rows } = await pool.query(
    `WITH matchups AS (
       SELECT
         f.season,
         f.goals_home,
         f.goals_away,
         f.home_winner,
         f.away_winner,
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
       COUNT(*)::int                                              AS total,
       SUM(CASE
         WHEN side = 'home' AND home_winner = TRUE THEN 1
         WHEN side = 'away' AND away_winner = TRUE THEN 1
         ELSE 0 END)::int                                        AS wins,
       SUM(CASE
         WHEN side = 'home' AND away_winner = TRUE THEN 1
         WHEN side = 'away' AND home_winner = TRUE THEN 1
         ELSE 0 END)::int                                        AS losses,
       SUM(CASE
         WHEN home_winner IS NULL
          AND goals_home IS NOT NULL THEN 1
         ELSE 0 END)::int                                        AS draws,
       ROUND(AVG((goals_home + goals_away)::numeric), 1)         AS avg_goals,
       MIN(season)::int                                          AS min_season,
       MAX(season)::int                                          AS max_season
     FROM matchups`,
    [formation, leagueIds && leagueIds.length ? leagueIds : null, seasons && seasons.length ? seasons : null],
  );

  const r = rows[0];
  if (!r || !r.total) {
    return {
      formation, total: 0,
      wins: 0, draws: 0, losses: 0,
      pct_win: 0, pct_draw: 0, pct_loss: 0,
      avg_goals: 0, min_season: null, max_season: null,
    };
  }

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
    avg_goals:  parseFloat(r.avg_goals ?? 0),
    min_season: r.min_season,
    max_season: r.max_season,
  };
}

/**
 * Times que mais usam uma formação ("domina o uso"), com aproveitamento.
 * Ordena por número de jogos (uso) e desempata por taxa de vitória.
 *
 * @param {string} formation
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{
 *   team_id: number, name: string, logo_url: string,
 *   games: number, wins: number, draws: number, losses: number, pct_win: number
 * }[]>}
 */
async function getTopTeamsForFormation(formation, { limit = 10, leagueIds = null, seasons = null } = {}) {
  const { rows } = await pool.query(
    `WITH team_games AS (
       SELECT
         fl.team_id,
         CASE WHEN fl.team_id = f.home_team_id THEN f.home_winner ELSE f.away_winner END AS won,
         f.home_winner,
         f.goals_home
       FROM fixture_lineups fl
       JOIN fixtures f ON f.id = fl.fixture_id
       WHERE fl.formation = $1
         AND f.status = 'FT'
         AND fl.team_id IN (f.home_team_id, f.away_team_id)
         AND ($3::int[] IS NULL OR f.league_id = ANY($3::int[]))
         AND ($4::int[] IS NULL OR f.season    = ANY($4::int[]))
     )
     SELECT
       t.id                                                       AS team_id,
       t.name                                                     AS name,
       t.logo_url                                                 AS logo_url,
       COUNT(*)::int                                              AS games,
       SUM(CASE WHEN tg.won = TRUE THEN 1 ELSE 0 END)::int        AS wins,
       SUM(CASE
         WHEN tg.home_winner IS NULL
          AND tg.goals_home IS NOT NULL THEN 1
         ELSE 0 END)::int                                         AS draws,
       SUM(CASE
         WHEN tg.won = FALSE THEN 1 ELSE 0 END)::int              AS losses
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

/**
 * Times com pior aproveitamento usando a formação (mín. de jogos configurável).
 * Espelho de getTopTeamsForFormation, mas ordena por taxa de vitória crescente.
 *
 * @param {string} formation
 * @param {{ limit?: number, leagueIds?: number[]|null, minGames?: number }} [opts]
 */
async function getWorstTeamsForFormation(formation, { limit = 5, leagueIds = null, minGames = 5, seasons = null } = {}) {
  const { rows } = await pool.query(
    `WITH team_games AS (
       SELECT
         fl.team_id,
         CASE WHEN fl.team_id = f.home_team_id THEN f.home_winner ELSE f.away_winner END AS won,
         f.home_winner,
         f.goals_home
       FROM fixture_lineups fl
       JOIN fixtures f ON f.id = fl.fixture_id
       WHERE fl.formation = $1
         AND f.status = 'FT'
         AND fl.team_id IN (f.home_team_id, f.away_team_id)
         AND ($3::int[] IS NULL OR f.league_id = ANY($3::int[]))
         AND ($5::int[] IS NULL OR f.season    = ANY($5::int[]))
     )
     SELECT
       t.id                                                       AS team_id,
       t.name                                                     AS name,
       t.logo_url                                                 AS logo_url,
       COUNT(*)::int                                              AS games,
       SUM(CASE WHEN tg.won = TRUE  THEN 1 ELSE 0 END)::int      AS wins,
       SUM(CASE
         WHEN tg.home_winner IS NULL
          AND tg.goals_home IS NOT NULL THEN 1
         ELSE 0 END)::int                                        AS draws,
       SUM(CASE WHEN tg.won = FALSE THEN 1 ELSE 0 END)::int      AS losses
     FROM team_games tg
     JOIN teams t ON t.id = tg.team_id
     GROUP BY t.id, t.name, t.logo_url
     HAVING COUNT(*) >= $4
     ORDER BY
       SUM(CASE WHEN tg.won = TRUE THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) ASC,
       COUNT(*) DESC
     LIMIT $2`,
    [formation, limit, leagueIds && leagueIds.length ? leagueIds : null, minGames, seasons && seasons.length ? seasons : null],
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

/**
 * W/D/L da formação contra cada formação adversária (modo geral/overview).
 * Retorna apenas confrontos com pelo menos 3 partidas, ordenados por taxa de vitória.
 *
 * @param {string} formation
 * @param {number[]|null} leagueIds
 * @returns {Promise<{ opponent_formation: string, total: number, wins: number, draws: number, losses: number, pct_win: number }[]>}
 */
async function getFormationMatchups(formation, leagueIds = null, seasons = null) {
  const { rows } = await pool.query(
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

/**
 * Lista os campeonatos conhecidos (leagues.js) com a contagem de partidas que
 * já têm escalação no banco. Alimenta o filtro de ligas no frontend: ligas com
 * games = 0 ainda não foram populadas (a API-football precisa rodar via seed).
 *
 * @returns {Promise<{ id: number, name: string, country: string, games: number }[]>}
 */
async function getLeagues() {
  const { rows } = await pool.query(
    `SELECT f.league_id, COUNT(DISTINCT f.id)::int AS games
       FROM fixtures f
       JOIN fixture_lineups fl ON fl.fixture_id = f.id
      WHERE f.status = 'FT'
      GROUP BY f.league_id`,
  );
  const counts = new Map(rows.map((r) => [parseInt(r.league_id), r.games]));
  return LEAGUES.map((l) => ({ ...l, games: counts.get(l.id) || 0 }));
}

/**
 * Retorna o texto de análise de IA em cache para um par de formações.
 * Sempre consulta na ordem canônica (alfabética) para que A vs B = B vs A.
 *
 * @param {string} formA
 * @param {string} formB
 * @returns {Promise<string|null>}
 */
async function getCachedAnalysis(formA, formB) {
  const [a, b] = [formA, formB].sort();
  const { rows } = await pool.query(
    `SELECT analysis_text FROM formation_analyses
     WHERE formation_a = $1 AND formation_b = $2`,
    [a, b],
  );
  return rows[0]?.analysis_text ?? null;
}

/**
 * Salva (ou atualiza) a análise de IA para um par de formações.
 *
 * @param {string} formA
 * @param {string} formB
 * @param {string} text   Texto completo gerado pelo Ollama
 */
async function saveAnalysis(formA, formB, text) {
  const [a, b] = [formA, formB].sort();
  await pool.query(
    `INSERT INTO formation_analyses (formation_a, formation_b, analysis_text)
     VALUES ($1, $2, $3)
     ON CONFLICT (formation_a, formation_b) DO UPDATE
       SET analysis_text = EXCLUDED.analysis_text,
           generated_at  = NOW()`,
    [a, b, text],
  );
}

/**
 * Temporadas disponíveis no banco (com ao menos uma partida finalizada).
 * @returns {Promise<number[]>}
 */
async function getSeasons() {
  const { rows } = await pool.query(
    `SELECT DISTINCT season::int AS season FROM fixtures WHERE status = 'FT' ORDER BY season DESC`,
  );
  return rows.map(r => r.season);
}

module.exports = {
  pool,
  searchByFormations,
  getFixturesWithoutLineups,
  saveLineups,
  getStats,
  getSeasons,
  getFormationStats,
  getFormationOverall,
  getFormationMatchups,
  getTopTeamsForFormation,
  getWorstTeamsForFormation,
  getLeagues,
  getCachedAnalysis,
  saveAnalysis,
};
