/**
 * generate-sql.js
 * Reads cache.json and writes brasileirao.sql with:
 *   - DDL (CREATE TABLE)
 *   - DML (INSERT) for all 2024 and 2025 fixture data
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache.json'), 'utf8'));

const SEASONS = ['71_2024', '71_2025'];

// ─── Collect all fixtures across seasons ─────────────────────────────────────

const allFixtures = SEASONS.flatMap(key => cache.fixtures[key] ?? []);
const lineups     = cache.lineups ?? {};

// ─── Escape helpers ───────────────────────────────────────────────────────────

const esc   = v => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const num   = v => (v == null ? 'NULL' : String(v));
const bool  = v => (v == null ? 'NULL' : v ? 'TRUE' : 'FALSE');

// ─── Entity deduplication ────────────────────────────────────────────────────

// League (single: id 71)
const leagueRow = allFixtures.length > 0
  ? allFixtures[0].league
  : { id: 71, name: 'Serie A', country: 'Brazil',
      logo: 'https://media.api-sports.io/football/leagues/71.png',
      flag: 'https://media.api-sports.io/flags/br.svg' };

// Teams
const teamsMap = new Map();
for (const f of allFixtures) {
  for (const side of ['home', 'away']) {
    const t = f.teams[side];
    teamsMap.set(t.id, { id: t.id, name: t.name, logo_url: t.logo });
  }
}
const teams = [...teamsMap.values()].sort((a, b) => a.id - b.id);

// Venues — API id can be null; assign surrogate starting at 9001
const venuesByApiId  = new Map(); // api_id  -> venue row
const venuesByNameCity = new Map(); // 'name|city' -> venue row
let surrogateSeq = 9000;

for (const f of allFixtures) {
  const v = f.fixture.venue;
  if (v.id) {
    if (!venuesByApiId.has(v.id)) {
      venuesByApiId.set(v.id, { id: v.id, api_id: v.id, name: v.name, city: v.city });
    }
  } else {
    const key = `${v.name}|${v.city}`;
    if (!venuesByNameCity.has(key)) {
      surrogateSeq++;
      venuesByNameCity.set(key, { id: surrogateSeq, api_id: null, name: v.name, city: v.city });
    }
  }
}

const venues = [
  ...[...venuesByApiId.values()].sort((a, b) => a.id - b.id),
  ...[...venuesByNameCity.values()],
];

function resolveVenueId(venue) {
  if (venue.id) return venue.id;
  return venuesByNameCity.get(`${venue.name}|${venue.city}`)?.id ?? null;
}

// ─── Build SQL lines ──────────────────────────────────────────────────────────

const lines = [];

const hr  = s => `-- ${'─'.repeat(70)}\n-- ${s}\n-- ${'─'.repeat(70)}`;
const sec = s => `\n${hr(s)}\n`;

// ── Header ────────────────────────────────────────────────────────────────────
lines.push(`-- ════════════════════════════════════════════════════════════════════
-- brasileirao.sql
-- Brasileirão Série A — partidas finalizadas (temporadas 2024 / 2025)
-- Gerado em: ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC
-- Fonte     : https://v3.football.api-sports.io  (league_id = 71)
-- Dialeto   : PostgreSQL 14+
-- ════════════════════════════════════════════════════════════════════
`);

// ── Extensions / settings ─────────────────────────────────────────────────────
lines.push(`SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
`);

// ── DDL ───────────────────────────────────────────────────────────────────────
lines.push(sec('DDL — CREATE TABLES'));

lines.push(`
-- Liga de futebol
CREATE TABLE IF NOT EXISTS leagues (
  id         INTEGER      PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  country    VARCHAR(100) NOT NULL,
  logo_url   TEXT,
  flag_url   TEXT
);

-- Times participantes
CREATE TABLE IF NOT EXISTS teams (
  id       INTEGER      PRIMARY KEY,
  name     VARCHAR(100) NOT NULL,
  logo_url TEXT
);

-- Estádios / venues
-- api_id: identificador original da API (NULL para arenas sem id externo)
-- id    : chave primária local (= api_id quando disponível; surrogate >= 9001 caso contrário)
CREATE TABLE IF NOT EXISTS venues (
  id      INTEGER      PRIMARY KEY,
  api_id  INTEGER      UNIQUE,
  name    VARCHAR(200) NOT NULL,
  city    VARCHAR(200)
);

-- Partida (cabeçalho)
CREATE TABLE IF NOT EXISTS fixtures (
  id            INTEGER      PRIMARY KEY,
  league_id     INTEGER      NOT NULL REFERENCES leagues(id),
  season        SMALLINT     NOT NULL,
  round         VARCHAR(60)  NOT NULL,
  home_team_id  INTEGER      NOT NULL REFERENCES teams(id),
  away_team_id  INTEGER      NOT NULL REFERENCES teams(id),
  venue_id      INTEGER      REFERENCES venues(id),
  referee       VARCHAR(200),
  date_utc      TIMESTAMPTZ  NOT NULL,
  status        CHAR(10)     NOT NULL DEFAULT 'FT',
  goals_home    SMALLINT,
  goals_away    SMALLINT,
  home_winner   BOOLEAN,
  away_winner   BOOLEAN
);

-- Placar detalhado por período
CREATE TABLE IF NOT EXISTS fixture_scores (
  fixture_id     INTEGER  PRIMARY KEY REFERENCES fixtures(id) ON DELETE CASCADE,
  ht_home        SMALLINT,   -- intervalo
  ht_away        SMALLINT,
  ft_home        SMALLINT,   -- tempo regulamentar
  ft_away        SMALLINT,
  et_home        SMALLINT,   -- prorrogação
  et_away        SMALLINT,
  pk_home        SMALLINT,   -- pênaltis
  pk_away        SMALLINT
);

-- Formação tática por time em cada partida
-- Fonte: /fixtures/lineups  (registros inseridos apenas quando a API retornou dado)
CREATE TABLE IF NOT EXISTS fixture_lineups (
  fixture_id  INTEGER      NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id     INTEGER      NOT NULL REFERENCES teams(id),
  formation   VARCHAR(20)  NOT NULL,
  PRIMARY KEY (fixture_id, team_id)
);
`);

// ── INDEXES ───────────────────────────────────────────────────────────────────
lines.push(`-- Índices auxiliares
CREATE INDEX IF NOT EXISTS idx_fixtures_season        ON fixtures (season);
CREATE INDEX IF NOT EXISTS idx_fixtures_round         ON fixtures (round);
CREATE INDEX IF NOT EXISTS idx_fixtures_home_team     ON fixtures (home_team_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_away_team     ON fixtures (away_team_id);
CREATE INDEX IF NOT EXISTS idx_fixture_lineups_team   ON fixture_lineups (team_id);
CREATE INDEX IF NOT EXISTS idx_fixture_lineups_fmt    ON fixture_lineups (formation);
`);

// ── DML — leagues ─────────────────────────────────────────────────────────────
lines.push(sec('DML — leagues'));
lines.push(`INSERT INTO leagues (id, name, country, logo_url, flag_url) VALUES`);
lines.push(`  (${leagueRow.id}, ${esc(leagueRow.name)}, ${esc(leagueRow.country)}, ${esc(leagueRow.logo ?? leagueRow.logo_url)}, ${esc(leagueRow.flag ?? leagueRow.flag_url)})`);
lines.push(`ON CONFLICT (id) DO NOTHING;\n`);

// ── DML — teams ───────────────────────────────────────────────────────────────
lines.push(sec(`DML — teams (${teams.length} registros)`));
const teamRows = teams.map(
  t => `  (${t.id}, ${esc(t.name)}, ${esc(t.logo_url)})`
);
lines.push(`INSERT INTO teams (id, name, logo_url) VALUES\n${teamRows.join(',\n')}\nON CONFLICT (id) DO NOTHING;\n`);

// ── DML — venues ──────────────────────────────────────────────────────────────
lines.push(sec(`DML — venues (${venues.length} registros)`));
const venueRows = venues.map(
  v => `  (${v.id}, ${num(v.api_id)}, ${esc(v.name)}, ${esc(v.city)})`
);
lines.push(`INSERT INTO venues (id, api_id, name, city) VALUES\n${venueRows.join(',\n')}\nON CONFLICT (id) DO NOTHING;\n`);

// ── DML — fixtures ────────────────────────────────────────────────────────────
lines.push(sec(`DML — fixtures (${allFixtures.length} registros)`));

const fixtureBatches = chunk(allFixtures, 50);
for (const batch of fixtureBatches) {
  const rows = batch.map(f => {
    const vid = resolveVenueId(f.fixture.venue);
    return (
      `  (${f.fixture.id}, ${f.league.id}, ${f.league.season}, ` +
      `${esc(f.league.round)}, ${f.teams.home.id}, ${f.teams.away.id}, ` +
      `${num(vid)}, ${esc(f.fixture.referee)}, ` +
      `${esc(f.fixture.date)}, ${esc(f.fixture.status.short)}, ` +
      `${num(f.goals.home)}, ${num(f.goals.away)}, ` +
      `${bool(f.teams.home.winner)}, ${bool(f.teams.away.winner)})`
    );
  });
  lines.push(
    `INSERT INTO fixtures\n` +
    `  (id, league_id, season, round, home_team_id, away_team_id,\n` +
    `   venue_id, referee, date_utc, status, goals_home, goals_away,\n` +
    `   home_winner, away_winner)\nVALUES\n${rows.join(',\n')}\nON CONFLICT (id) DO NOTHING;\n`
  );
}

// ── DML — fixture_scores ──────────────────────────────────────────────────────
lines.push(sec(`DML — fixture_scores (${allFixtures.length} registros)`));

const scoreBatches = chunk(allFixtures, 50);
for (const batch of scoreBatches) {
  const rows = batch.map(f => {
    const s = f.score;
    return (
      `  (${f.fixture.id}, ` +
      `${num(s.halftime.home)}, ${num(s.halftime.away)}, ` +
      `${num(s.fulltime.home)}, ${num(s.fulltime.away)}, ` +
      `${num(s.extratime.home)}, ${num(s.extratime.away)}, ` +
      `${num(s.penalty.home)}, ${num(s.penalty.away)})`
    );
  });
  lines.push(
    `INSERT INTO fixture_scores\n` +
    `  (fixture_id, ht_home, ht_away, ft_home, ft_away,\n` +
    `   et_home, et_away, pk_home, pk_away)\nVALUES\n${rows.join(',\n')}\nON CONFLICT (fixture_id) DO NOTHING;\n`
  );
}

// ── DML — fixture_lineups ─────────────────────────────────────────────────────

const lineupRows = [];
for (const f of allFixtures) {
  const lin = lineups[String(f.fixture.id)];
  if (!lin) continue;
  for (const [teamId, formation] of Object.entries(lin)) {
    if (formation) {
      lineupRows.push({ fixture_id: f.fixture.id, team_id: parseInt(teamId), formation });
    }
  }
}
lineupRows.sort((a, b) => a.fixture_id - b.fixture_id || a.team_id - b.team_id);

lines.push(sec(`DML — fixture_lineups (${lineupRows.length} registros)`));

if (lineupRows.length > 0) {
  const lineupBatches = chunk(lineupRows, 100);
  for (const batch of lineupBatches) {
    const rows = batch.map(
      r => `  (${r.fixture_id}, ${r.team_id}, ${esc(r.formation)})`
    );
    lines.push(
      `INSERT INTO fixture_lineups (fixture_id, team_id, formation)\nVALUES\n${rows.join(',\n')}\nON CONFLICT (fixture_id, team_id) DO NOTHING;\n`
    );
  }
} else {
  lines.push(`-- Nenhum dado de lineup disponível no cache atual.\n`);
}

// ── Footer stats ──────────────────────────────────────────────────────────────
const seasons2024 = allFixtures.filter(f => f.league.season === 2024).length;
const seasons2025 = allFixtures.filter(f => f.league.season === 2025).length;
const withBothLineups = new Set(
  lineupRows.map(r => r.fixture_id)
).size;

lines.push(`
-- ════════════════════════════════════════════════════════════════════
-- Resumo da importação
--   Temporada 2024 : ${String(seasons2024).padStart(4)} partidas
--   Temporada 2025 : ${String(seasons2025).padStart(4)} partidas (API retornou 0 — plano gratuito)
--   Venues         : ${String(venues.length).padStart(4)} (${[...venuesByApiId.keys()].length} com ID da API + ${[...venuesByNameCity.keys()].length} com ID gerado)
--   Times          : ${String(teams.length).padStart(4)}
--   Lineups        : ${String(lineupRows.length).padStart(4)} linhas (${withBothLineups} partidas com formação registrada)
-- ════════════════════════════════════════════════════════════════════
`);

// ─── Write output ─────────────────────────────────────────────────────────────

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const sql = lines.join('\n');
const outFile = path.join(__dirname, 'brasileirao.sql');
fs.writeFileSync(outFile, sql, 'utf8');

console.log(`\n  brasileirao.sql gerado com sucesso.`);
console.log(`  Temporadas : 2024 (${seasons2024} partidas) | 2025 (${seasons2025} partidas)`);
console.log(`  Venues     : ${venues.length} | Times: ${teams.length}`);
console.log(`  Lineups    : ${lineupRows.length} linhas (${withBothLineups} jogos)\n`);
