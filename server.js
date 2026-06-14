'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const db      = require('./db');
const ai      = require('./ai');

const app  = express();
const PORT = process.env.PORT || 3000;

// Formação válida: 3 ou 4 setores numéricos (ex.: 4-3-3, 4-2-3-1).
const isValidFormation = (f) => /^\d-\d(-\d){1,2}$/.test(f);

// Filtro de ligas: "71,39" → [71, 39]; vazio/ausente → null (todas as ligas).
const parseLeagues = (v) => {
  if (!v) return null;
  const ids = String(v).split(',').map((s) => parseInt(s, 10)).filter(Number.isInteger);
  return ids.length ? ids : null;
};

// Filtro de temporadas: "2024,2023" → [2024, 2023]; vazio/ausente → null (todas).
const parseSeasons = (v) => {
  if (!v) return null;
  const years = String(v).split(',').map((s) => parseInt(s, 10)).filter(n => !isNaN(n));
  return years.length ? years : null;
};

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

  if (!formation_a || !isValidFormation(formation_a)) {
    return res.status(400).json({ error: 'formation_a é obrigatória e deve ter o formato 4-3-3.' });
  }
  if (formation_b && !isValidFormation(formation_b)) {
    return res.status(400).json({ error: 'formation_b inválida — use o formato 4-3-3.' });
  }

  const leagues = parseLeagues(req.query.leagues);
  const seasons = parseSeasons(req.query.seasons);

  try {
    // Sem formation_b → modo "geral": a formação contra todas as outras + times que dominam.
    if (!formation_b) {
      const [overall, teams, matchups, analysis] = await Promise.all([
        db.getFormationOverall(formation_a, leagues, seasons),
        db.getTopTeamsForFormation(formation_a, { leagueIds: leagues, seasons }),
        db.getFormationMatchups(formation_a, leagues, seasons),
        db.getCachedAnalysis(formation_a, 'ALL'),
      ]);
      return res.json({ mode: 'overall', ...overall, teams, matchups, analysis });
    }

    const [stats, analysis] = await Promise.all([
      db.getFormationStats(formation_a, formation_b, leagues, seasons),
      db.getCachedAnalysis(formation_a, formation_b),
    ]);
    res.json({ mode: 'matchup', ...stats, analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/generate ───────────────────────────────────────────────────────
// SSE — gera análise via Ollama e salva no banco.
// Chamado pelo botão "Gerar análise" no frontend local.

app.get('/api/generate', async (req, res) => {
  const { formation_a, formation_b } = req.query;

  if (!formation_a || !formation_b || !isValidFormation(formation_a) || !isValidFormation(formation_b)) {
    return res.status(400).json({ error: 'formation_a e formation_b são obrigatórias (formato 4-3-3).' });
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
    const seasons = parseSeasons(req.query.seasons);
    const stats = await db.getFormationStats(formation_a, formation_b, null, seasons);

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

// ─── GET /api/generate-overview ──────────────────────────────────────────────
// SSE — gera análise da formação no modo "geral" via Ollama e salva no banco.

app.get('/api/generate-overview', async (req, res) => {
  const { formation_a } = req.query;

  if (!formation_a || !isValidFormation(formation_a)) {
    return res.status(400).json({ error: 'formation_a é obrigatória (formato 4-3-3).' });
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
    const seasons = parseSeasons(req.query.seasons);
    const [overall, teams, matchups, worstTeams] = await Promise.all([
      db.getFormationOverall(formation_a, null, seasons),
      db.getTopTeamsForFormation(formation_a, { limit: 5, seasons }),
      db.getFormationMatchups(formation_a, null, seasons),
      db.getWorstTeamsForFormation(formation_a, { limit: 5, seasons }),
    ]);

    if (!overall.total) {
      write('error', { message: 'Nenhuma partida encontrada para essa formação.' });
    } else {
      await ai.streamOverviewAnalysis(
        { formation: formation_a, overall, teams, matchups, worstTeams },
        (event, payload) => {
          write(event, payload);
          if (event === 'text') fullText += payload.chunk ?? '';
        },
      );

      if (fullText.trim()) {
        await db.saveAnalysis(formation_a, 'ALL', fullText.trim());
        write('saved', {});
      }
    }
  } catch (err) {
    write('error', { message: err.message ?? 'Erro interno.' });
  }

  write('done', {});
  res.end();
});

// ─── GET /api/seasons ─────────────────────────────────────────────────────────

app.get('/api/seasons', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({ seasons: await db.getSeasons() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/leagues ──────────────────────────────────────────────────────────
// Campeonatos conhecidos + contagem de jogos com escalação (alimenta o filtro).

app.get('/api/leagues', async (_req, res) => {
  try {
    res.json(await db.getLeagues());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
