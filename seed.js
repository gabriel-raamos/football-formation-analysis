/**
 * seed.js — Alimenta o banco com todas as partidas finalizadas do Brasileirão
 *
 * Uso:
 *   node seed.js                     # todas as temporadas, até 90 chamadas de lineup
 *   node seed.js --season 2023       # apenas temporada específica
 *   node seed.js --max-calls 50      # limita chamadas de lineup (default: 90)
 *   node seed.js --fixtures-only     # apenas tabela de fixtures, sem lineups
 *
 * O script é idempotente: pode ser executado múltiplas vezes sem duplicar dados.
 * Ao atingir o limite de chamadas, pare e execute novamente no dia seguinte.
 */

'use strict';
require('dotenv').config();
const axios  = require('axios');
const { Pool } = require('pg');

// ─── Config ───────────────────────────────────────────────────────────────────

const LEAGUE_ID  = 71;
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

const args        = process.argv.slice(2);
const seasonArg   = args.includes('--season')       ? parseInt(args[args.indexOf('--season') + 1])       : null;
const maxCalls    = args.includes('--max-calls')     ? parseInt(args[args.indexOf('--max-calls') + 1])    : 90;
const fixturesOnly = args.includes('--fixtures-only');

const targetSeasons = seasonArg ? [seasonArg] : ALL_SEASONS;

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

async function seedFixtures(season) {
  // check if season already in DB
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM fixtures WHERE season = $1', [season]
  );
  const existing = rows[0].cnt;

  if (existing > 0) {
    log(`  [${season}] ${existing} partidas já no banco — pulando busca de fixtures.`);
    return existing;
  }

  log(`  [${season}] Buscando fixtures na API…`);
  const { data } = await api.get('/fixtures', {
    params: { league: LEAGUE_ID, season, status: 'FT' },
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

async function seedLineups(maxApiCalls) {
  const { rows: missing } = await pool.query(
    `SELECT f.id, f.home_team_id, f.away_team_id, f.season
     FROM fixtures f
     WHERE NOT EXISTS (
       SELECT 1 FROM fixture_lineups fl WHERE fl.fixture_id = f.id
     )
     ORDER BY f.season, f.id`
  );

  if (missing.length === 0) {
    log('\n  Todas as partidas já têm escalação no banco. Nada a fazer.');
    return { saved: 0, total: 0, remaining: 0 };
  }

  const toProcess = missing.slice(0, maxApiCalls);
  log(`\n  Fixtures sem lineup: ${missing.length}`);
  log(`  Chamadas nesta execução: ${toProcess.length} (limite: ${maxApiCalls})`);
  log('');

  let saved     = 0;
  let apiCalls  = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { id, home_team_id, away_team_id } = toProcess[i];

    try {
      const { data } = await api.get('/fixtures/lineups', { params: { fixture: id } });
      apiCalls++;
      await delay(DELAY_MS);

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
        return { saved, total: toProcess.length, remaining: missing.length - i };
      }
      logSame(`  [${i + 1}/${toProcess.length}] fixture ${id} → erro: ${err.message}`);
    }
  }

  log('');
  return { saved, total: toProcess.length, remaining: missing.length - toProcess.length };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  log('\n═══════════════════════════════════════════════════════');
  log('  Seed — Brasileirão Série A (2020+)');
  log('═══════════════════════════════════════════════════════\n');

  try {
    await initVenueCache();
    log(`  Cache de venues carregado: ${venueByApiId.size + venueByKey.size} venues.\n`);
  } catch (e) {
    log(`  ERRO ao conectar ao banco: ${e.message}`);
    log('  Verifique DATABASE_URL no arquivo .env\n');
    process.exit(1);
  }

  // ── Phase 1: fixtures ──
  log('── Fase 1: Fixtures ──────────────────────────────────');
  let totalFixtures = 0;
  for (const season of targetSeasons) {
    try {
      totalFixtures += await seedFixtures(season);
      await delay(400); // delay entre chamadas de fixtures
    } catch (e) {
      if (e.response?.status === 429) {
        log(`\n  ⚠  Rate limit atingido ao buscar fixtures de ${season}.`);
        log('  Execute novamente amanhã.\n');
        break;
      }
      log(`  ERRO em ${season}: ${e.message}`);
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
  const result = await seedLineups(maxCalls);

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
