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

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── GET /api/analysis ────────────────────────────────────────────────────────
//
// Uso local com Ollama.
// Gera a análise via IA, faz SSE para o browser e, ao finalizar,
// persiste o texto completo no banco (formation_analyses) para que
// o Vercel possa servi-lo sem precisar de servidor local.

app.get('/api/analysis', async (req, res) => {
  const { formation_a, formation_b } = req.query;

  if (!formation_a || !formation_b) {
    return res.status(400).json({ error: 'formation_a e formation_b são obrigatórios.' });
  }

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let fullText = '';

  // Intercepta os eventos de texto para montar o texto completo
  const send = (event, payload) => {
    sse(res, event, payload);
    if (event === 'text') fullText += payload.chunk ?? '';
  };

  try {
    const stats = await db.getFormationStats(formation_a, formation_b);
    send('stats', stats);

    if (stats.total > 0) {
      await ai.streamAnalysis(stats, send);

      // Persiste no banco para que o Vercel sirva sem Ollama
      if (fullText.trim()) {
        await db.saveAnalysis(formation_a, formation_b, fullText.trim());
      }
    }
  } catch (err) {
    send('api-error', { message: err.message ?? 'Erro interno.' });
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
  console.log(`\n  Servidor local em http://localhost:${PORT}`);
  try {
    const s = await db.getStats();
    console.log(`  Banco : ${s.fixtures} partidas · ${s.lineups} lineups · ${s.teams} times`);
  } catch {
    console.warn('  Banco : não conectado — verifique DATABASE_URL no .env');
  }
  console.log();
});
