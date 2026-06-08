'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const db      = require('./db');
const ai      = require('./ai');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── GET /api/analysis ────────────────────────────────────────────────────────
// Retorna JSON — mesmo contrato do Vercel (api/analysis.js).
// Frontend faz fetch() e recebe stats + análise em cache.

app.get('/api/analysis', async (req, res) => {
  const { formation_a, formation_b } = req.query;

  if (!formation_a || !formation_b) {
    return res.status(400).json({ error: 'formation_a e formation_b são obrigatórios.' });
  }

  try {
    const [stats, analysis] = await Promise.all([
      db.getFormationStats(formation_a, formation_b),
      db.getCachedAnalysis(formation_a, formation_b),
    ]);
    res.json({ ...stats, analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/generate ───────────────────────────────────────────────────────
// SSE — gera análise via Ollama e salva no banco.
// Chamado pelo botão "Gerar análise" no frontend local.

app.get('/api/generate', async (req, res) => {
  const { formation_a, formation_b } = req.query;

  if (!formation_a || !formation_b) {
    return res.status(400).json({ error: 'formation_a e formation_b são obrigatórios.' });
  }

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let fullText = '';

  try {
    const stats = await db.getFormationStats(formation_a, formation_b);

    if (!stats.total) {
      write('error', { message: 'Nenhuma partida encontrada para essas formações.' });
    } else {
      await ai.streamAnalysis(stats, (event, payload) => {
        write(event, payload);
        if (event === 'text') fullText += payload.chunk ?? '';
      });

      if (fullText.trim()) {
        await db.saveAnalysis(formation_a, formation_b, fullText.trim());
        write('saved', {});
      }
    }
  } catch (err) {
    write('error', { message: err.message ?? 'Erro interno.' });
  }

  write('done', {});
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
