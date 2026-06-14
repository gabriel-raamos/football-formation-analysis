/**
 * generate-analyses.js — Pré-gera todas as análises do Ollama e salva no banco.
 *
 * Uso:
 *   node generate-analyses.js                  # gera tudo (matchups + overviews)
 *   node generate-analyses.js --matchups-only  # apenas confrontos h2h
 *   node generate-analyses.js --overview-only  # apenas análises gerais por formação
 *   node generate-analyses.js --force          # regenera mesmo o que já está em cache
 *   node generate-analyses.js --dry-run        # mostra o que seria gerado, sem gerar
 *
 * O script é idempotente: pula análises já em cache (a menos que --force).
 * Ollama deve estar rodando localmente: ollama serve
 */

'use strict';
require('dotenv').config();
const db = require('./db');
const ai = require('./ai');

const args          = process.argv.slice(2);
const MATCHUPS_ONLY = args.includes('--matchups-only');
const OVERVIEW_ONLY = args.includes('--overview-only');
const FORCE         = args.includes('--force');
const DRY_RUN       = args.includes('--dry-run');
const DELAY_MS      = 300;

const delay = ms => new Promise(r => setTimeout(r, ms));
const log   = msg => process.stdout.write(msg + '\n');
const same  = msg => process.stdout.write('\r' + msg.padEnd(80));

async function getDistinctFormations() {
  const { rows } = await db.pool.query(
    `SELECT DISTINCT formation FROM fixture_lineups WHERE formation IS NOT NULL ORDER BY formation`,
  );
  return rows.map(r => r.formation);
}

async function runMatchups(formations) {
  log('\n── Análises de confronto h2h ────────────────────────────────────────────────');

  const pairs = [];
  for (let i = 0; i < formations.length; i++) {
    for (let j = i + 1; j < formations.length; j++) {
      pairs.push([formations[i], formations[j]]);
    }
  }
  log(`   ${pairs.length} pares possíveis`);

  let generated = 0, skipped = 0, errors = 0;

  for (const [fmtA, fmtB] of pairs) {
    const label = `${fmtA} vs ${fmtB}`;

    if (!FORCE) {
      const cached = await db.getCachedAnalysis(fmtA, fmtB);
      if (cached) { same(`   [SKIP] ${label}`); skipped++; continue; }
    }

    const stats = await db.getFormationStats(fmtA, fmtB);
    if (!stats.total) { same(`   [ZERO] ${label}`); skipped++; continue; }

    if (DRY_RUN) { log(`   [DRY ] ${label} — ${stats.total} partidas`); continue; }

    try {
      same(`   [GEN ] ${label} (${stats.total} partidas)...`);
      const text = await ai.completeAnalysis(stats);
      await db.saveAnalysis(fmtA, fmtB, text);
      log(`   [OK  ] ${label}`);
      generated++;
    } catch (err) {
      log(`   [ERRO] ${label}: ${err.message}`);
      errors++;
    }

    await delay(DELAY_MS);
  }

  return { generated, skipped, errors };
}

async function runOverviews(formations) {
  log('\n── Análises gerais por formação (vs todas) ──────────────────────────────────');
  log(`   ${formations.length} formações`);

  let generated = 0, skipped = 0, errors = 0;

  for (const formation of formations) {
    const label = `${formation} (geral)`;

    if (!FORCE) {
      const cached = await db.getCachedAnalysis(formation, 'ALL');
      if (cached) { same(`   [SKIP] ${label}`); skipped++; continue; }
    }

    const [overall, teams, matchups, worstTeams] = await Promise.all([
      db.getFormationOverall(formation),
      db.getTopTeamsForFormation(formation, { limit: 5 }),
      db.getFormationMatchups(formation),
      db.getWorstTeamsForFormation(formation, { limit: 5 }),
    ]);

    if (!overall.total) { same(`   [ZERO] ${label}`); skipped++; continue; }

    if (DRY_RUN) { log(`   [DRY ] ${label} — ${overall.total} partidas`); continue; }

    try {
      same(`   [GEN ] ${label} (${overall.total} partidas)...`);
      const text = await ai.completeOverviewAnalysis({ formation, overall, teams, matchups, worstTeams });
      await db.saveAnalysis(formation, 'ALL', text);
      log(`   [OK  ] ${label}`);
      generated++;
    } catch (err) {
      log(`   [ERRO] ${label}: ${err.message}`);
      errors++;
    }

    await delay(DELAY_MS);
  }

  return { generated, skipped, errors };
}

async function main() {
  log('═══════════════════════════════════════════════════════════════════════════');
  log(' generate-analyses.js — pré-geração de análises Ollama');
  if (DRY_RUN)       log(' Modo: DRY RUN (nada será salvo)');
  if (FORCE)         log(' Modo: FORCE (regenera cache existente)');
  if (MATCHUPS_ONLY) log(' Escopo: apenas matchups h2h');
  if (OVERVIEW_ONLY) log(' Escopo: apenas overviews gerais');
  log('═══════════════════════════════════════════════════════════════════════════');

  log('\nBuscando formações no banco...');
  const formations = await getDistinctFormations();
  if (!formations.length) {
    log('Nenhuma formação encontrada. Execute seed.js primeiro.');
    process.exit(1);
  }
  log(`${formations.length} formações: ${formations.join(', ')}`);

  let totGen = 0, totSkip = 0, totErr = 0;

  if (!OVERVIEW_ONLY) {
    const r = await runMatchups(formations);
    totGen += r.generated; totSkip += r.skipped; totErr += r.errors;
  }

  if (!MATCHUPS_ONLY) {
    const r = await runOverviews(formations);
    totGen += r.generated; totSkip += r.skipped; totErr += r.errors;
  }

  log('\n═══════════════════════════════════════════════════════════════════════════');
  log(` Geradas: ${totGen}  |  Puladas (cache/zero): ${totSkip}  |  Erros: ${totErr}`);
  log('═══════════════════════════════════════════════════════════════════════════');

  await db.pool.end();
}

main().catch(err => {
  console.error('\nErro fatal:', err.message);
  process.exit(1);
});
