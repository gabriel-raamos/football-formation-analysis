'use strict';
// Vercel Serverless Function
// Roda na nuvem — conecta ao Supabase e usa Groq para IA.
// Não precisa de servidor local nem ngrok.

const { Pool } = require('pg');

// Pool reutilizado entre warm invocations do Vercel
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

// ─── SSE ─────────────────────────────────────────────────────────────────────

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Stats query ──────────────────────────────────────────────────────────────

async function getStats(formA, formB) {
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
     )
     SELECT
       COUNT(*)::int                                            AS total,
       SUM(CASE
         WHEN side_a = 'home' AND home_winner = TRUE  THEN 1
         WHEN side_a = 'away' AND away_winner = TRUE  THEN 1
         ELSE 0 END)::int                                      AS wins_a,
       SUM(CASE
         WHEN side_a = 'home' AND away_winner = TRUE  THEN 1
         WHEN side_a = 'away' AND home_winner = TRUE  THEN 1
         ELSE 0 END)::int                                      AS wins_b,
       SUM(CASE
         WHEN home_winner IS NULL
          AND goals_home  IS NOT NULL THEN 1
         ELSE 0 END)::int                                      AS draws,
       ROUND(AVG((goals_home + goals_away)::numeric), 1)       AS avg_goals,
       MIN(season)::int                                        AS min_season,
       MAX(season)::int                                        AS max_season
     FROM matchups`,
    [formA, formB],
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

// ─── Groq streaming ───────────────────────────────────────────────────────────

function buildPrompt(s) {
  const period = s.min_season === s.max_season
    ? String(s.min_season)
    : `${s.min_season}–${s.max_season}`;
  return `Você é um analista tático do Brasileirão Série A. Seja direto e objetivo.

Confronto: ${s.formation_a} vs ${s.formation_b}
Série A ${period} — ${s.total} partidas finalizadas

${s.formation_a}: ${s.wins_a} vitórias (${s.pct_a}%)
Empates: ${s.draws} (${s.pct_draw}%)
${s.formation_b}: ${s.wins_b} vitórias (${s.pct_b}%)
Média de gols por partida: ${s.avg_goals}

Escreva exatamente 2 frases em português:
1. Qual formação tem vantagem e se ela é significativa ou marginal.
2. Uma razão tática plausível para esse resultado no futebol brasileiro.

Sem introdução, sem listas. Apenas as 2 frases.`;
}

async function streamGroq(apiKey, stats, res) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model:      'llama-3.1-8b-instant',
      messages:   [{ role: 'user', content: buildPrompt(stats) }],
      stream:     true,
      max_tokens: 350,
    }),
  });

  if (!response.ok) {
    sse(res, 'text', { chunk: `Erro Groq (${response.status}): ${response.statusText}` });
    return;
  }

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let   buf     = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try {
        const chunk = JSON.parse(raw).choices?.[0]?.delta?.content;
        if (chunk) sse(res, 'text', { chunk });
      } catch { /* fragmento inválido, ignorar */ }
    }
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const { formation_a, formation_b } = req.query;

  if (!formation_a || !formation_b) {
    return res.status(400).json({ error: 'formation_a e formation_b são obrigatórios.' });
  }

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  try {
    // 1. Dados do banco (Supabase)
    const stats = await getStats(formation_a, formation_b);
    sse(res, 'stats', stats);

    if (stats.total > 0) {
      // 2. Análise IA via Groq (se GROQ_API_KEY configurado no Vercel)
      const groqKey = process.env.GROQ_API_KEY;
      if (groqKey) {
        await streamGroq(groqKey, stats, res);
      } else {
        sse(res, 'text', {
          chunk: 'Adicione GROQ_API_KEY nas variáveis de ambiente do Vercel para ativar a análise de IA.',
        });
      }
    }
  } catch (err) {
    sse(res, 'api-error', { message: err.message ?? 'Erro interno.' });
  }

  sse(res, 'done', {});
  res.end();
};
