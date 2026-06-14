'use strict';
require('dotenv').config();
const { Ollama } = require('ollama');

const OLLAMA_URL   = (process.env.OLLAMA_URL   || 'http://localhost:11434').replace(/"/g, '').trim();
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || 'llama3.2').replace(/"/g, '').trim();

const ollama = new Ollama({ host: OLLAMA_URL });

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt({ formation_a, formation_b, total, wins_a, wins_b, draws,
                       pct_a, pct_b, pct_draw, avg_goals, min_season, max_season }) {
  const period = min_season === max_season ? String(min_season) : `${min_season}–${max_season}`;

  return `Você é um analista tático do Brasileirão Série A. Seja direto e objetivo.

Confronto: ${formation_a} vs ${formation_b}
Série A ${period} — ${total} partida${total !== 1 ? 's' : ''} finalizadas

${formation_a}: ${wins_a} vitória${wins_a !== 1 ? 's' : ''} (${pct_a}%)
Empates: ${draws} (${pct_draw}%)
${formation_b}: ${wins_b} vitória${wins_b !== 1 ? 's' : ''} (${pct_b}%)
Média de gols por partida: ${avg_goals}

Escreva exatamente 2 frases em português:
1. Qual formação tem vantagem e se ela é significativa ou marginal.
2. Uma razão tática plausível para esse resultado no contexto do futebol brasileiro.

Sem introdução, sem listas, sem marcadores. Apenas as 2 frases.`;
}

// ─── Streaming ────────────────────────────────────────────────────────────────

/**
 * Faz streaming da análise tática via Ollama para a resposta SSE.
 *
 * @param {object}   stats   objeto de db.getFormationStats()
 * @param {Function} sseFn   (event: string, payload: object) => void
 */
async function streamAnalysis(stats, sseFn) {
  if (stats.total < 3) {
    sseFn('text', {
      chunk: `Amostra insuficiente (${stats.total} partida${stats.total !== 1 ? 's' : ''}). ` +
             `Execute o seed script para popular o banco com mais dados.`,
    });
    return;
  }

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
        ? `Ollama não está rodando em ${OLLAMA_URL}. Inicie com: ollama serve`
        : `Erro ao conectar ao Ollama: ${err.message}`,
    });
    return;
  }

  for await (const part of stream) {
    const chunk = part.message?.content;
    if (chunk) sseFn('text', { chunk });
  }
}

module.exports = { streamAnalysis, buildPrompt };
