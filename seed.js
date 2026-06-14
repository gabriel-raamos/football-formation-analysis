/**
 * seed.js — Alimenta o banco com partidas finalizadas das principais ligas
 *
 * Uso:
 *   node seed.js                       # Brasileirão, todas as temporadas
 *   node seed.js --league 39           # outra liga específica (39 Premier, 140 La Liga, 135 Serie A, 78 Bundesliga, 61 Ligue 1)
 *   node seed.js --all-leagues         # todas as ligas configuradas em leagues.js
 *   node seed.js --season 2023         # apenas temporada específica
 *   node seed.js --max-calls 50        # limita chamadas de lineup (default: 90)
 *   node seed.js --fixtures-only       # apenas tabela de fixtures, sem lineups
 *
 * O script é idempotente: pode ser executado múltiplas vezes sem duplicar dados.
 * Ao atingir o limite de chamadas, pare e execute novamente no dia seguinte.
 * Com --all-leagues, os fixtures de todas as ligas são inseridos primeiro e depois
 * os lineups são populados até o limite diário de chamadas.
 */

'use strict';
require('dotenv').config();
const axios  = require('axios');
const { Pool } = require('pg');
const { LEAGUES, leagueName } = require('./leagues');

// ─── Config ───────────────────────────────────────────────────────────────────

// Liga a ingerir: --league <id> ou env LEAGUE_ID (default 71 = Brasileirão).
const _leagueArg = process.argv.includes('--league')
  ? parseInt(process.argv[process.argv.indexOf('--league') + 1], 10)
  : null;
const LEAGUE_ID  = _leagueArg || parseInt(process.env.LEAGUE_ID || '', 10) || 71;
const DELAY_MS   = 310;
const ALL_SEASONS = [2020, 2021, 2022, 2023, 2024, 2025];

const API_KEY  = (process.env.API_KEY  || '').replace(/"/g, '').trim();
const BASE_URL = (process.env.URL      || '').replace(/"/g, '').trim();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'x-apisports-key': API_KEY },
  timeout: 15000,
});

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args         = process.argv.slice(2);
const maxCalls     = args.includes('--max-calls')    ? parseInt(args[args.indexOf('--max-calls') + 1]) : 90;
const fixturesOnly = args.includes('--fixtures-only');
const allLeagues   = args.includes('--all-leagues');

// --seasons 2022,2023,2024  OU  --season 2023 (singular, retrocompat)
const _seasonsArg = args.includes('--seasons')
  ? args[args.indexOf('--seasons') + 1]
  : args.includes('--season')
    ? args[args.indexOf('--season') + 1]
    : null;
const targetSeasons = _seasonsArg
  ? _seasonsArg.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n))
  : ALL_SEASONS;

const targetLeagueIds = allLeagues
  ? LEAGUES.map(l => l.id)
  : [LEAGUE_ID];

// ─── Utilities ────────────────────────────────────────────────────────────────

const delay    = ms  => new Promise(r => setTimeout(r, ms));
const log      = msg => process.stdout.write(msg + '\n');
const logSame  = msg => process.stdout.write('\r' + msg.padEnd(80));

// ─── Venue cache (in-memory to avoid N+1 lookups) ────────────────────────────

const venueByApiId  = new Map();
const venueByKey    = new Map();
let   maxVenueId    = 9000;

async function initVenueCache() {
  const { rows } = await pool.query('SELECT id, api_id, name, city FROM venues');
  for (const v of rows) {
    const id = parseInt(v.id);
    if (v.api_id) venueByApiId.set(parseInt(v.api_id), id);
    else          venueByKey.set(`${v.name}|${v.city}`, id);
    if (id > maxVenueId) maxVenueId = id;
  }
}

async function upsertVenue(v) {
  if (!v || (!v.id && !v.name)) return null;

  if (v.id) {
    if (!venueByApiId.has(v.id)) {
      await pool.query(
        `INSERT INTO venues (id, api_id, name, city) VALUES ($1,$1,$2,$3) ON CONFLICT (id) DO NOTHING`,
        [v.id, v.name || '', v.city || null],
      );
      venueByApiId.set(v.id, v.id);
    }
    return v.id;
  }

  const key = `${v.name}|${v.city}`;
  if (venueByKey.has(key)) return venueByKey.get(key);

  const newId = ++maxVenueId;
  await pool.query(
    `INSERT INTO venues (id, api_id, name, city) VALUES ($1, NULL, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [newId, v.name, v.city || null],
  );
  venueByKey.set(key, newId);
  return newId;
}

// ─── League upsert (garante FK antes dos fixtures) ───────────────────────────

async function ensureLeagues() {
  for (const l of LEAGUES) {
    await pool.query(
      `INSERT INTO leagues (id, name, country, logo_url, flag_url)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [
        l.id,
        l.name,
        l.country,
        `https://media.api-sports.io/football/leagues/${l.id}.png`,
        null,
      ],
    );
  }
}

// ─── Fixture insertion ────────────────────────────────────────────────────────

async function upsertTeam(t) {
  await pool.query(
    `INSERT INTO teams (id, name, logo_url) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, logo_url=EXCLUDED.logo_url`,
    [t.id, t.name, t.logo],
  );
}

async function upsertFixture(f, leagueRow, venueId) {
  // fixture row
  await pool.query(
    `INSERT INTO fixtures
       (id, league_id, season, round, home_team_id, away_team_id,
        venue_id, referee, date_utc, status, goals_home, goals_away,
        home_winner, away_winner)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id) DO NOTHING`,
    [
      f.fixture.id,
      leagueRow.id,
      leagueRow.season,
      leagueRow.round,
      f.teams.home.id,
      f.teams.away.id,
      venueId,
      f.fixture.referee || null,
      f.fixture.date,
      f.fixture.status.short,
      f.goals.home,
      f.goals.away,
      f.teams.home.winner,
      f.teams.away.winner,
    ],
  );

  // score row
  const s = f.score;
  await pool.query(
    `INSERT INTO fixture_scores
       (fixture_id, ht_home, ht_away, ft_home, ft_away,
        et_home, et_away, pk_home, pk_away)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (fixture_id) DO NOTHING`,
    [
      f.fixture.id,
      s.halftime.home,  s.halftime.away,
      s.fulltime.home,  s.fulltime.away,
      s.extratime.home, s.extratime.away,
      s.penalty.home,   s.penalty.away,
    ],
  );
}

// ─── Phase 1: fetch & store fixtures for each season ─────────────────────────

async function seedFixtures(season, leagueId = LEAGUE_ID) {
  // check if season already in DB
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM fixtures WHERE season = $1 AND league_id = $2', [season, leagueId]
  );
  const existing = rows[0].cnt;

  if (existing > 0) {
    log(`  [${season}] ${existing} partidas já no banco — pulando busca de fixtures.`);
    return existing;
  }

  log(`  [${season}] Buscando fixtures na API…`);
  const { data } = await api.get('/fixtures', {
    params: { league: leagueId, season, status: 'FT' },
  });

  const fixtures = data.response ?? [];
  log(`  [${season}] ${fixtures.length} partidas encontradas. Inserindo no banco…`);

  let inserted = 0;
  for (const f of fixtures) {
    await upsertTeam(f.teams.home);
    await upsertTeam(f.teams.away);
    const venueId = await upsertVenue(f.fixture.venue);
    await upsertFixture(f, f.league, venueId);
    inserted++;
  }

  log(`  [${season}] ✓ ${inserted} partidas inseridas.`);
  return inserted;
}

// ─── Phase 2: fetch & store lineups for fixtures without them ─────────────────

async function seedLineups(maxApiCalls, leagueIds = null, seasons = null) {
  // Helpers para filtros opcionais — usam parâmetros posicionais a partir de `offset`
  const hasSeasons = seasons && seasons.length > 0;

  // Retorna { clause, params } onde clause inclui os placeholders e params os valores
  // Condição: fixture ainda não checado OU checado mas lineup encontrado (não tenta de novo se já checou e veio vazio)
  const notCheckedOrHasLineup = `(f.lineup_checked_at IS NULL) AND NOT EXISTS (SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id)`;

  function buildMissingQuery(leagueId, limit) {
    const params = [leagueId];
    let clause = `WHERE f.league_id = $1`;
    if (hasSeasons) { params.push(seasons); clause += ` AND f.season = ANY($${params.length}::int[])`; }
    clause += ` AND ${notCheckedOrHasLineup}`;
    const select = `SELECT f.id, f.home_team_id, f.away_team_id, f.season, f.league_id FROM fixtures f ${clause} ORDER BY f.season DESC, f.id`;
    if (limit) { params.push(limit); return { sql: select + ` LIMIT $${params.length}`, params }; }
    return { sql: select, params };
  }

  function buildCountQuery(leagueId) {
    const params = [leagueId];
    let clause = `WHERE f.league_id = $1`;
    if (hasSeasons) { params.push(seasons); clause += ` AND f.season = ANY($${params.length}::int[])`; }
    clause += ` AND ${notCheckedOrHasLineup}`;
    return { sql: `SELECT COUNT(*)::int AS n FROM fixtures f ${clause}`, params };
  }

  let toProcess = [];

  if (leagueIds && leagueIds.length > 1) {
    // Distribui os calls uniformemente entre ligas
    const perLeague = Math.max(1, Math.ceil(maxApiCalls / leagueIds.length));
    let totalMissing = 0;
    for (const lid of leagueIds) {
      const q = buildMissingQuery(lid, perLeague);
      const { rows } = await pool.query(q.sql, q.params);
      toProcess.push(...rows);
      const c = buildCountQuery(lid);
      const { rows: cnt } = await pool.query(c.sql, c.params);
      totalMissing += cnt[0].n;
    }
    toProcess = toProcess.slice(0, maxApiCalls);
    const seasonsLabel = hasSeasons ? ` · temporadas ${seasons.join(',')}` : '';
    log(`\n  Fixtures sem lineup: ${totalMissing} (distribuindo entre ${leagueIds.length} ligas${seasonsLabel})`);
  } else {
    // Liga única ou sem filtro de liga
    const lid = leagueIds && leagueIds.length === 1 ? leagueIds[0] : null;
    let sql, params;
    if (lid) {
      const q = buildMissingQuery(lid, null);
      sql = q.sql; params = q.params;
    } else {
      params = [];
      let clause = `WHERE f.lineup_checked_at IS NULL AND NOT EXISTS (SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id)`;
      if (hasSeasons) { params.push(seasons); clause += ` AND f.season = ANY($${params.length}::int[])`; }
      sql = `SELECT f.id, f.home_team_id, f.away_team_id, f.season, f.league_id FROM fixtures f ${clause} ORDER BY f.season DESC, f.id`;
    }
    const { rows: missing } = await pool.query(sql, params);
    if (missing.length === 0) {
      log('\n  Todas as partidas já têm escalação no banco. Nada a fazer.');
      return { saved: 0, total: 0, remaining: 0 };
    }
    toProcess = missing.slice(0, maxApiCalls);
    log(`\n  Fixtures sem lineup: ${missing.length}`);
  }

  if (toProcess.length === 0) {
    log('\n  Todas as partidas já têm escalação no banco. Nada a fazer.');
    return { saved: 0, total: 0, remaining: 0 };
  }
  log(`  Chamadas nesta execução: ${toProcess.length} (limite: ${maxApiCalls})`);
  log('');

  let saved    = 0;
  let apiCalls = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { id, home_team_id, away_team_id } = toProcess[i];

    try {
      const { data } = await api.get('/fixtures/lineups', { params: { fixture: id } });
      apiCalls++;
      await delay(DELAY_MS);

      // Marca que já tentamos buscar esse fixture (mesmo que retorne vazio)
      await pool.query(`UPDATE fixtures SET lineup_checked_at = NOW() WHERE id = $1`, [id]);

      const lineupMap = {};
      for (const entry of data.response ?? []) {
        if (entry.team?.id && entry.formation) {
          lineupMap[String(entry.team.id)] = entry.formation;
        }
      }

      if (Object.keys(lineupMap).length > 0) {
        for (const [teamId, formation] of Object.entries(lineupMap)) {
          await pool.query(
            `INSERT INTO fixture_lineups (fixture_id, team_id, formation)
             VALUES ($1,$2,$3) ON CONFLICT (fixture_id, team_id) DO NOTHING`,
            [id, parseInt(teamId), formation],
          );
        }
        saved++;
      }

      const homeFmt = lineupMap[String(home_team_id)] || '?';
      const awayFmt = lineupMap[String(away_team_id)] || '?';
      logSame(`  [${i + 1}/${toProcess.length}] fixture ${id} → ${homeFmt} vs ${awayFmt}`);
    } catch (err) {
      if (err.response?.status === 429) {
        log(`\n\n  ⚠  Rate limit atingido após ${apiCalls} chamadas.`);
        log(`  Execute novamente amanhã para continuar.\n`);
        return { saved, total: apiCalls, remaining: toProcess.length - i };
      }
      logSame(`  [${i + 1}/${toProcess.length}] fixture ${id} → erro: ${err.message}`);
    }
  }

  log('');
  // Re-conta quantos ainda faltam (sem lineup E ainda não checados = nunca tentados)
  const { rows: rem } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM fixtures f
     WHERE f.lineup_checked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id)`,
  );
  return { saved, total: apiCalls, remaining: rem[0].n };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const ligasLabel = allLeagues
    ? `todas as ligas (${targetLeagueIds.length})`
    : leagueName(LEAGUE_ID);

  log('\n═══════════════════════════════════════════════════════');
  log(`  Seed — ${ligasLabel}`);
  log(`  Temporadas: ${targetSeasons.join(', ')}`);
  log('═══════════════════════════════════════════════════════\n');

  try {
    await initVenueCache();
    log(`  Cache de venues carregado: ${venueByApiId.size + venueByKey.size} venues.`);
    await ensureLeagues();
    log(`  Ligas garantidas no banco.\n`);
  } catch (e) {
    log(`  ERRO ao conectar ao banco: ${e.message}`);
    log('  Verifique DATABASE_URL no arquivo .env\n');
    process.exit(1);
  }

  // ── Phase 1: fixtures (para cada liga) ────────────────
  log('── Fase 1: Fixtures ──────────────────────────────────');
  let totalFixtures = 0;
  for (const leagueId of targetLeagueIds) {
    if (targetLeagueIds.length > 1) log(`\n  Liga: ${leagueName(leagueId)} (${leagueId})`);
    for (const season of targetSeasons) {
      try {
        totalFixtures += await seedFixtures(season, leagueId);
        await delay(400);
      } catch (e) {
        if (e.response?.status === 429) {
          log(`\n  ⚠  Rate limit atingido ao buscar fixtures de ${season}.`);
          log('  Execute novamente amanhã.\n');
          break;
        }
        log(`  ERRO em ${season}: ${e.message}`);
      }
    }
  }

  if (fixturesOnly) {
    log(`\n  --fixtures-only: encerrando após inserir fixtures.`);
    log(`  Total: ${totalFixtures} fixtures no banco.\n`);
    await pool.end();
    return;
  }

  // ── Phase 2: lineups ──
  log('\n── Fase 2: Lineups ───────────────────────────────────');
  // Passa filtro de temporadas apenas quando especificado via --seasons (não quando é ALL_SEASONS padrão)
  const lineupSeasons = _seasonsArg ? targetSeasons : null;
  const result = await seedLineups(maxCalls, allLeagues ? targetLeagueIds : null, lineupSeasons);

  log('\n═══════════════════════════════════════════════════════');
  log('  Resumo');
  log('═══════════════════════════════════════════════════════');
  log(`  Lineups salvas esta execução : ${result.saved}`);
  log(`  Chamadas realizadas          : ${result.total}`);

  if (result.remaining > 0) {
    log(`  Fixtures ainda sem lineup    : ${result.remaining}`);
    log(`\n  Execute novamente amanhã para continuar (limite da API: 100/dia).`);
  } else {
    log(`  Banco completamente populado!`);
  }

  log('');
  await pool.end();
})();
