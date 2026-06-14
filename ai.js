'use strict';
require('dotenv').config();
const { Ollama } = require('ollama');

const OLLAMA_URL   = (process.env.OLLAMA_URL   || 'http://localhost:11434').replace(/"/g, '').trim();
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || 'llama3.2').replace(/"/g, '').trim();

const ollama = new Ollama({ host: OLLAMA_URL });

// ─── Veredito (calculado em código) ───────────────────────────────────────────
// O modelo local (llama3.2, 3B) não compara os números de forma confiável — chega
// a afirmar que uma formação "tem mais vitórias" num empate. Então a frase factual
// (quem leva vantagem ou se é equilíbrio) é decidida AQUI, e o modelo só escreve a
// razão tática em cima dela. Isso garante a correção independente do modelo.

function computeVerdict({ formation_a, formation_b, total, wins_a, wins_b }) {
  const diff = wins_a - wins_b;
  if (Math.abs(diff) <= 1) {
    return 'As duas formações têm desempenho praticamente igual nesta amostra, ficando em equilíbrio.';
  }
  const lider = diff > 0 ? formation_a : formation_b;
  return total < 8
    ? `O ${lider} leva uma vantagem marginal (mais vitórias), mas a amostra é pequena para conclusões firmes.`
    : `O ${lider} leva vantagem, vencendo mais confrontos.`;
}

// ─── Prompt (só a razão tática) ────────────────────────────────────────────────

function buildPrompt(stats) {
  const { formation_a, formation_b, total, wins_a, wins_b, draws,
          pct_a, pct_b, pct_draw, avg_goals, min_season, max_season } = stats;
  const period = min_season === max_season ? String(min_season) : `${min_season}–${max_season}`;
  const verdict = computeVerdict(stats);

  return `Você é um analista tático do Brasileirão Série A. Seja direto e objetivo.

Confronto: ${formation_a} vs ${formation_b}
Série A ${period} — ${total} partida${total !== 1 ? 's' : ''} finalizada${total !== 1 ? 's' : ''}
${formation_a}: ${wins_a} vitória${wins_a !== 1 ? 's' : ''} (${pct_a}%) · Empates: ${draws} (${pct_draw}%) · ${formation_b}: ${wins_b} vitória${wins_b !== 1 ? 's' : ''} (${pct_b}%)
Média de gols por partida: ${avg_goals}

Conclusão já definida: ${verdict}

Escreva UMA única frase em português com uma razão tática plausível, no contexto do futebol brasileiro, para esse resultado — coerente com a conclusão acima. Não repita os números, não invente placares nem detalhes de partidas específicas. Sem introdução e sem marcadores, apenas a frase.`;
}

// ─── Geração ──────────────────────────────────────────────────────────────────

const INSUFFICIENT = (total) =>
  `Amostra insuficiente (${total} partida${total !== 1 ? 's' : ''}). ` +
  `Execute o seed script para popular o banco com mais dados.`;

/**
 * Gera a análise completa (veredito + razão) via Ollama, sem streaming.
 * Usado pela pré-geração em lote (scripts/generate-analyses.js).
 *
 * @param {object} stats   objeto de db.getFormationStats()
 * @returns {Promise<string>}
 */
async function completeAnalysis(stats) {
  if (stats.total < 3) return INSUFFICIENT(stats.total);

  const verdict = computeVerdict(stats);
  const res = await ollama.chat({
    model:    OLLAMA_MODEL,
    messages: [{ role: 'user', content: buildPrompt(stats) }],
    stream:   false,
  });

  const reason = (res.message?.content || '').trim();
  return reason ? `${verdict} ${reason}` : verdict;
}

/**
 * Faz streaming da análise tática via Ollama para a resposta SSE.
 * Emite primeiro o veredito (calculado em código) e depois a razão do modelo.
 *
 * @param {object}   stats   objeto de db.getFormationStats()
 * @param {Function} sseFn   (event: string, payload: object) => void
 */
async function streamAnalysis(stats, sseFn) {
  if (stats.total < 3) {
    sseFn('text', { chunk: INSUFFICIENT(stats.total) });
    return;
  }

  // Veredito factual primeiro — não depende do modelo.
  sseFn('text', { chunk: computeVerdict(stats) + ' ' });

  let stream;
  try {
    stream = await ollama.chat({
      model:    OLLAMA_MODEL,
      messages: [{ role: 'user', content: buildPrompt(stats) }],
      stream:   true,
    });
  } catch (err) {
    const isOffline = err.cause?.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED');
    sseFn('text', {
      chunk: isOffline
        ? `(Ollama não está rodando em ${OLLAMA_URL}. Inicie com: ollama serve)`
        : `(Erro ao conectar ao Ollama: ${err.message})`,
    });
    return;
  }

  for await (const part of stream) {
    const chunk = part.message?.content;
    if (chunk) sseFn('text', { chunk });
  }
}

module.exports = { streamAnalysis, completeAnalysis, buildPrompt, computeVerdict };
