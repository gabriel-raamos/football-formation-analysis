'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const db      = require('./db');
const ai      = require('./ai');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── SSE helper ───────────────────────────────────────────────────────────────

function sse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// ─── Static front-end ─────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ─── GET /api/analysis ────────────────────────────────────────────────────────
//
// Fluxo SSE:
//   1. Consulta o banco → emite evento "stats"  (instantâneo)
//   2. Chama Claude API em streaming → emite eventos "text" (chunk a chunk)
//   3. Emite "done" ao concluir
//
// Eventos:
//   stats      { formation_a, formation_b, total, wins_a, wins_b, draws,
//                pct_a, pct_b, pct_draw, avg_goals, min_season, max_season }
//   text       { chunk: string }
//   done       {}
//   api-error  { message: string }

app.get('/api/analysis', async (req, res) => {
  const { formation_a, formation_b } = req.query;

  if (!formation_a || !formation_b) {
    return res.status(400).json({ error: 'formation_a e formation_b são obrigatórios.' });
  }

  if (formation_a === formation_b) {
    return res.status(400).json({ error: 'As formações devem ser diferentes.' });
  }

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, payload) => sse(res, event, payload);

  try {
    // ── 1. DB query (instantâneo) ─────────────────────────────────────────────
    const stats = await db.getFormationStats(formation_a, formation_b);
    send('stats', stats);

    // ── 2. Streaming da análise IA ────────────────────────────────────────────
    await ai.streamAnalysis(stats, send);
  } catch (err) {
    send('api-error', { message: err.message ?? 'Erro interno do servidor.' });
  }

  send('done', {});
  res.end();
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────

app.get('/api/stats', async (_req, res) => {
  try {
    res.json(await db.getStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n  Servidor em http://localhost:${PORT}`);
  try {
    const s = await db.getStats();
    console.log(`  Banco     : ${s.fixtures} partidas · ${s.lineups} lineups · ${s.teams} times`);
  } catch {
    console.warn('  Banco     : não conectado — verifique DATABASE_URL no .env');
  }
  console.log();
});
