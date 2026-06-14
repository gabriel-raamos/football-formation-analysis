'use strict';
/**
 * generate-analyses.js — Pré-gera as análises táticas com a API da Anthropic (Claude)
 * e salva no cache `formation_analyses`. Em produção (Vercel) não há Ollama, então
 * pré-aquecer o cache garante que o endpoint /api/analysis sirva o texto pronto.
 *
 * É idempotente: por padrão só gera o que ainda não está em cache e tem amostra
 * suficiente. O texto gerado é equivalente ao do botão "Gerar com Ollama" — mesma
 * função buildPrompt() de ai.js.
 *
 * Uso:
 *   node scripts/generate-analyses.js                 # gera o que falta (>= 3 partidas)
 *   node scripts/generate-analyses.js --force         # regenera mesmo se já houver cache
 *   node scripts/generate-analyses.js --min-games 5   # só pares com >= 5 partidas
 *   node scripts/generate-analyses.js --limit 10      # no máximo 10 chamadas ao Claude
 *   node scripts/generate-analyses.js --dry-run       # lista o que faria, sem chamar a API
 *   node scripts/generate-analyses.js --model claude-haiku-4-5
 *
 * Requer no .env (ou no ambiente):
 *   ANTHROPIC_API_KEY   chave da API da Anthropic
 *   DATABASE_URL        conexão com o banco (igual ao restante do projeto)
 * Opcional:
 *   ANTHROPIC_MODEL     sobrescreve o modelo padrão (claude-opus-4-8)
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const { buildPrompt } = require('../ai');

// ─── CLI ────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const hasFlag  = (f) => args.includes(f);
const flagVal  = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

const force    = hasFlag('--force');
const dryRun   = hasFlag('--dry-run');
const minGames = parseInt(flagVal('--min-games') ?? '3', 10);
const limit    = flagVal('--limit') ? parseInt(flagVal('--limit'), 10) : Infinity;
const MODEL    = (flagVal('--model') || process.env.ANTHROPIC_MODEL || 'claude-opus-4-8').trim();

const MAX_TOKENS = 512; // a análise são 2 frases curtas

const log = (msg) => process.stdout.write(msg + '\n');

// ─── Descoberta de formações e pares ──────────────────────────────────────────

async function distinctFormations() {
  const { rows } = await db.pool.query(
    `SELECT DISTINCT formation
       FROM fixture_lineups
      WHERE formation ~ '^[0-9]-[0-9]'
      ORDER BY formation`,
  );
  return rows.map((r) => r.formation);
}

function unorderedPairs(items) {
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      pairs.push([items[i], items[j]]);
    }
  }
  return pairs;
}

// ─── Geração ──────────────────────────────────────────────────────────────────

async function generateText(client, stats) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: buildPrompt(stats) }],
  });

  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  log('\n═══════════════════════════════════════════════════════');
  log('  Pré-geração de análises — Claude');
  log('═══════════════════════════════════════════════════════');
  log(`  Modelo     : ${MODEL}`);
  log(`  Min. jogos : ${minGames}`);
  log(`  Limite     : ${limit === Infinity ? 'sem limite' : limit}`);
  log(`  Modo       : ${dryRun ? 'DRY-RUN (sem chamadas à API)' : force ? 'FORCE (regenera tudo)' : 'normal (só o que falta)'}\n`);

  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    log('  ERRO: ANTHROPIC_API_KEY não definida no .env.');
    log('  Adicione a chave da API da Anthropic ao .env e rode de novo.');
    log('  (Ou use --dry-run para listar o que seria gerado, sem custo.)\n');
    process.exit(1);
  }

  let formations;
  try {
    formations = await distinctFormations();
  } catch (e) {
    log(`  ERRO ao conectar ao banco: ${e.message}`);
    log('  Verifique DATABASE_URL no .env\n');
    process.exit(1);
  }

  const pairs = unorderedPairs(formations);
  log(`  Formações no banco : ${formations.length}`);
  log(`  Pares possíveis    : ${pairs.length}\n`);

  const client = dryRun ? null : new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente

  let generated = 0;
  let skippedFew = 0;
  let skippedCached = 0;
  let errors = 0;

  for (const [a, b] of pairs) {
    if (generated >= limit) {
      log(`\n  Limite de ${limit} geração(ões) atingido — parando.`);
      break;
    }

    const stats = await db.getFormationStats(a, b);
    if (stats.total < minGames) { skippedFew++; continue; }

    if (!force && (await db.getCachedAnalysis(a, b))) { skippedCached++; continue; }

    if (dryRun) {
      log(`  [geraria] ${a} vs ${b}  (${stats.total} partidas)`);
      generated++;
      continue;
    }

    try {
      const text = await generateText(client, stats);
      if (text) {
        await db.saveAnalysis(a, b, text);
        generated++;
        log(`  [ok] ${a} vs ${b}  (${stats.total} partidas) → ${text.slice(0, 60)}…`);
      } else {
        errors++;
        log(`  [vazio] ${a} vs ${b} — resposta sem texto.`);
      }
    } catch (err) {
      errors++;
      log(`  [erro] ${a} vs ${b} — ${err.message}`);
    }
  }

  log('\n═══════════════════════════════════════════════════════');
  log('  Resumo');
  log('═══════════════════════════════════════════════════════');
  log(`  ${dryRun ? 'Geraria' : 'Geradas'}            : ${generated}`);
  log(`  Puladas (cache)      : ${skippedCached}`);
  log(`  Puladas (< ${minGames} jogos)  : ${skippedFew}`);
  if (errors) log(`  Erros                : ${errors}`);
  log('');

  await db.pool.end();
})();
