'use strict';
/**
 * generate-analyses.js — Pré-gera as análises táticas e salva no cache
 * `formation_analyses`. Em produção (Vercel) não há Ollama, então pré-aquecer
 * o cache garante que /api/analysis sirva o texto pronto.
 *
 * A frase factual (quem leva vantagem ou se é equilíbrio) vem do código
 * (ai.computeVerdict) — só a razão tática é gerada pelo modelo. É idempotente:
 * por padrão só gera o que falta e tem amostra suficiente.
 *
 * Uso:
 *   node scripts/generate-analyses.js                      # Ollama local, o que falta (>= 3 partidas)
 *   node scripts/generate-analyses.js --provider claude    # usa a API da Anthropic (paga)
 *   node scripts/generate-analyses.js --force              # regenera mesmo se já houver cache
 *   node scripts/generate-analyses.js --min-games 5        # só pares com >= 5 partidas
 *   node scripts/generate-analyses.js --limit 10           # no máximo 10 gerações
 *   node scripts/generate-analyses.js --dry-run            # lista o que faria, sem gerar
 *   node scripts/generate-analyses.js --provider claude --model claude-haiku-4-5
 *
 * Requer no .env (ou no ambiente):
 *   DATABASE_URL        conexão com o banco
 *   OLLAMA_URL/_MODEL   (provider ollama) — padrão localhost:11434 / llama3.2
 *   ANTHROPIC_API_KEY   (provider claude) — chave da API da Anthropic
 * Opcional: ANTHROPIC_MODEL sobrescreve o modelo Claude (padrão claude-opus-4-8)
 */

require('dotenv').config();
const db = require('../db');
const ai = require('../ai');

// ─── CLI ────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const hasFlag  = (f) => args.includes(f);
const flagVal  = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

const provider = (flagVal('--provider') || 'ollama').trim();
const force    = hasFlag('--force');
const dryRun   = hasFlag('--dry-run');
const minGames = parseInt(flagVal('--min-games') ?? '3', 10);
const limit    = flagVal('--limit') ? parseInt(flagVal('--limit'), 10) : Infinity;
const MODEL    = (flagVal('--model') || process.env.ANTHROPIC_MODEL || 'claude-opus-4-8').trim();

const log = (msg) => process.stdout.write(msg + '\n');

// ─── Geração por provider ─────────────────────────────────────────────────────

// Claude: o modelo escreve só a razão; o veredito (factual) vem do código.
function makeClaudeGenerator() {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente
  return async (stats) => {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: ai.buildPrompt(stats) }],
    });
    const reason = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return reason ? `${ai.computeVerdict(stats)} ${reason}` : ai.computeVerdict(stats);
  };
}

// Ollama: completeAnalysis já monta veredito + razão.
const ollamaGenerator = (stats) => ai.completeAnalysis(stats);

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
    for (let j = i + 1; j < items.length; j++) pairs.push([items[i], items[j]]);
  }
  return pairs;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  log('\n═══════════════════════════════════════════════════════');
  log('  Pré-geração de análises');
  log('═══════════════════════════════════════════════════════');
  log(`  Provider   : ${provider}${provider === 'claude' ? ` (${MODEL})` : ` (${(process.env.OLLAMA_MODEL || 'llama3.2')})`}`);
  log(`  Min. jogos : ${minGames}`);
  log(`  Limite     : ${limit === Infinity ? 'sem limite' : limit}`);
  log(`  Modo       : ${dryRun ? 'DRY-RUN (sem gerar)' : force ? 'FORCE (regenera tudo)' : 'normal (só o que falta)'}\n`);

  if (!['ollama', 'claude'].includes(provider)) {
    log(`  ERRO: --provider inválido: "${provider}". Use "ollama" ou "claude".\n`);
    process.exit(1);
  }
  if (provider === 'claude' && !dryRun && !process.env.ANTHROPIC_API_KEY) {
    log('  ERRO: ANTHROPIC_API_KEY não definida no .env (necessária para --provider claude).');
    log('  Use --provider ollama (grátis, local) ou adicione a chave.\n');
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

  const generate = dryRun ? null : (provider === 'claude' ? makeClaudeGenerator() : ollamaGenerator);

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
      const text = await generate(stats);
      if (text && text.trim()) {
        await db.saveAnalysis(a, b, text.trim());
        generated++;
        log(`  [ok] ${a} vs ${b}  (${stats.total}) → ${text.slice(0, 70)}…`);
      } else {
        errors++;
        log(`  [vazio] ${a} vs ${b} — sem texto gerado.`);
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
