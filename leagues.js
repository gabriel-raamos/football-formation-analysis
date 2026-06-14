'use strict';
// Mapa de campeonatos (ids da API-football, league id). Usado por:
//  - seed.js (qual liga ingerir, via --league)
//  - db.js / api (rótulos e validação)
//  - /api/leagues (exposto ao frontend para montar o filtro de checkboxes)

const LEAGUES = [
  { id: 71,  name: 'Brasileirão Série A', country: 'Brasil' },
  { id: 39,  name: 'Premier League',      country: 'Inglaterra' },
  { id: 140, name: 'La Liga',             country: 'Espanha' },
  { id: 135, name: 'Serie A (Itália)',     country: 'Itália' },
  { id: 78,  name: 'Bundesliga',          country: 'Alemanha' },
  { id: 61,  name: 'Ligue 1',             country: 'França' },
  { id: 128, name: 'Liga Profesional',    country: 'Argentina' },
];

const byId = new Map(LEAGUES.map((l) => [l.id, l]));

const leagueName = (id) => byId.get(Number(id))?.name || `Liga ${id}`;

module.exports = { LEAGUES, leagueName };
