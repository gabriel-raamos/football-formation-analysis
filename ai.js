'use strict';
require('dotenv').config();
const { Ollama } = require('ollama');
const { LEAGUES }  = require('./leagues');

const OLLAMA_URL   = (process.env.OLLAMA_URL   || 'http://localhost:11434').replace(/"/g, '').trim();
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || 'llama3.2').replace(/"/g, '').trim();

const ollama = new Ollama({ host: OLLAMA_URL });

// ─── Contexto de liga ─────────────────────────────────────────────────────────
// Converte array de IDs em rótulo legível para o prompt.

function leagueLabel(leagueIds) {
  if (!leagueIds || !leagueIds.length) return 'futebol europeu e sul-americano';
  const names = leagueIds
    .map(id => LEAGUES.find(l => l.id === id)?.name)
    .filter(Boolean);
  if (!names.length) return 'futebol europeu e sul-americano';
  if (names.length === 1) return names[0];
  if (names.length <= 3) return names.join(', ');
  return `${names.length} ligas selecionadas`;
}

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

// ─── Seção por liga ───────────────────────────────────────────────────────────

function formatMatchupLeagueSection(leagueStats, formationA, formationB) {
  if (!leagueStats || !leagueStats.length) return '';
  const lines = leagueStats.map(l =>
    `  ${l.league_name}: ${l.total} partidas — ${formationA}: ${l.wins_a}V (${l.pct_a}%) | Empates: ${l.draws} (${l.pct_draw}%) | ${formationB}: ${l.wins_b}V (${l.pct_b}%)`
  ).join('\n');
  return `\nEfetividade por liga (mín. 2 partidas):\n${lines}`;
}

function formatOverviewLeagueSection(leagueStats, formation) {
  if (!leagueStats || !leagueStats.length) return '';
  const lines = leagueStats.map(l =>
    `  ${l.league_name}: ${l.total} partidas — ${l.wins}V ${l.draws}E ${l.losses}D — ${l.pct_win}% vitórias — média ${l.avg_goals} gols/jogo`
  ).join('\n');
  return `\nDesempenho por liga (mín. 2 partidas):\n${lines}`;
}

// ─── Prompt (só a razão tática) ────────────────────────────────────────────────

function buildPrompt(stats) {
  const { formation_a, formation_b, total, wins_a, wins_b, draws,
          pct_a, pct_b, pct_draw, avg_goals, min_season, max_season,
          leagueIds, leagueStats } = stats;
  const period  = min_season === max_season ? String(min_season) : `${min_season}–${max_season}`;
  const context = leagueLabel(leagueIds);
  const verdict = computeVerdict(stats);

  const dominant   = wins_a >= wins_b ? formation_a : formation_b;
  const struggling = wins_a >= wins_b ? formation_b : formation_a;

  const leagueSection = formatMatchupLeagueSection(leagueStats, formation_a, formation_b);
  const leagueNames   = (leagueStats || []).map(l => l.league_name);
  const leagueLines   = leagueNames.length
    ? leagueNames.map(n => `${n}: [Uma frase sobre como o confronto se comporta nessa liga.]`).join('\n')
    : '';

  return `Você é um analista tático de futebol. Seja direto e objetivo.

Confronto: ${formation_a} vs ${formation_b}
${context} ${period} — ${total} partida${total !== 1 ? 's' : ''} finalizada${total !== 1 ? 's' : ''}
${formation_a}: ${wins_a} vitória${wins_a !== 1 ? 's' : ''} (${pct_a}%) · Empates: ${draws} (${pct_draw}%) · ${formation_b}: ${wins_b} vitória${wins_b !== 1 ? 's' : ''} (${pct_b}%)
Média de gols por partida: ${avg_goals}
${leagueSection}

Conclusão já definida: ${verdict}

Escreva os seguintes blocos em português, cada um em sua própria linha, iniciados EXATAMENTE pelos rótulos abaixo:

Formação dominante: [Uma frase sobre por que o ${dominant} tende a levar vantagem neste confronto — explique taticamente, sem repetir os números.]
Análise geral: [Uma frase com uma leitura tática do confronto ${formation_a} vs ${formation_b} — dinâmica de jogo, áreas de disputa, características que definem o duelo no contexto de ${context}.]
Formação com dificuldade: [Uma frase sobre por que o ${struggling} tende a ter dificuldade neste confronto — explique taticamente, sem repetir os números.]
${leagueLines ? `Efetividade por liga:\n${leagueLines}` : ''}

Comece diretamente pelo rótulo "Formação dominante:". Não repita números, não invente placares nem detalhes de partidas específicas. Sem introdução, sem marcadores adicionais. Para cada liga listada acima, escreva exatamente uma frase na linha correspondente ao nome da liga.`;
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

  const res = await ollama.chat({
    model:    OLLAMA_MODEL,
    messages: [{ role: 'user', content: buildPrompt(stats) }],
    stream:   false,
  });

  return (res.message?.content || '').trim() || computeVerdict(stats);
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

// ─── Análise de formação no modo "geral" (vs todas as outras) ─────────────────

function buildOverviewPrompt({ formation, overall, teams, matchups, worstTeams, leagueIds, leagueStats }) {
  const { total, wins, draws, losses, pct_win, avg_goals, min_season, max_season } = overall;
  const period  = min_season === max_season ? String(min_season) : `${min_season}–${max_season}`;
  const context = leagueLabel(leagueIds);

  const topMatchups = (matchups || []).slice(0, 5)
    .map(m => `  ${formation} vs ${m.opponent_formation}: ${m.wins}V ${m.draws}E ${m.losses}D — ${m.pct_win}% (${m.total} jogos)`)
    .join('\n') || '  Dados insuficientes.';

  const topTeam = (teams || [])[0];
  const topTeamLine = topTeam
    ? `  ${topTeam.name}: ${topTeam.wins}V ${topTeam.draws}E ${topTeam.losses}D — ${topTeam.pct_win}% (${topTeam.games} jogos)`
    : '  Dados insuficientes.';

  const otherTopTeams = (teams || []).slice(1, 5)
    .map(t => `  ${t.name}: ${t.wins}V ${t.draws}E ${t.losses}D — ${t.pct_win}% (${t.games} jogos)`)
    .join('\n') || '  —';

  const worstTeamsList = (worstTeams || []).slice(0, 5)
    .map(t => `  ${t.name}: ${t.wins}V ${t.draws}E ${t.losses}D — ${t.pct_win}% (${t.games} jogos)`)
    .join('\n') || '  Dados insuficientes.';

  const leagueSection = formatOverviewLeagueSection(leagueStats, formation);
  const leagueNames   = (leagueStats || []).map(l => l.league_name);
  const leagueLines   = leagueNames.length
    ? leagueNames.map(n => `${n}: [Uma frase sobre como o ${formation} se comporta nessa liga.]`).join('\n')
    : '';

  return `Você é um analista tático de futebol. Seja direto e objetivo.

Formação analisada: ${formation}
Contexto: ${context} (${period})
Desempenho geral: ${total} partidas — ${wins}V ${draws}E ${losses}D — ${pct_win}% de vitórias — média ${avg_goals} gols/jogo
${leagueSection}

Confrontos com melhores índices de vitória (top 5, mín. 3 jogos):
${topMatchups}

Time com melhor aproveitamento na ${formation}:
${topTeamLine}

Outros times relevantes:
${otherTopTeams}

Times com menor aproveitamento na ${formation} (mín. 5 jogos):
${worstTeamsList}

Escreva os seguintes blocos em português, cada um em sua própria linha, iniciados EXATAMENTE pelos rótulos abaixo:

Time dominante: [Uma ou duas frases sobre o time com melhor aproveitamento — cite o clube pelo nome, mencione suas vitórias, derrotas e porcentagem exata, e diga contra quais adversários ele se destacou mais.]
Análise geral: [Uma ou duas frases sobre os confrontos em que ${formation} tem vantagem estatística mais clara (cite as formações adversárias) e uma leitura tática breve sobre por que esse padrão ocorre.]
Times com dificuldade: [Uma ou duas frases sobre os times que tiveram menor aproveitamento, citando nomes e números, com uma possível explicação tática para o insucesso.]
${leagueLines ? `Efetividade por liga:\n${leagueLines}` : ''}

Comece diretamente pelo rótulo "Time dominante:". Sem introdução, sem listas, sem marcadores adicionais. Contextualize a análise para ${context}. Para cada liga listada acima, escreva exatamente uma frase na linha correspondente ao nome da liga.`;
}

async function streamOverviewAnalysis(data, sseFn) {
  if (!data.overall?.total) {
    sseFn('text', { chunk: 'Dados insuficientes para gerar análise.' });
    return;
  }

  let stream;
  try {
    stream = await ollama.chat({
      model:    OLLAMA_MODEL,
      messages: [{ role: 'user', content: buildOverviewPrompt(data) }],
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

/**
 * Gera análise de formação no modo geral (overview) sem streaming.
 * Usado pelo script de pré-geração em lote.
 *
 * @param {{ formation: string, overall: object, teams: object[], matchups: object[], worstTeams: object[] }} data
 * @returns {Promise<string>}
 */
async function completeOverviewAnalysis(data) {
  if (!data.overall?.total) return 'Dados insuficientes para gerar análise.';

  const res = await ollama.chat({
    model:    OLLAMA_MODEL,
    messages: [{ role: 'user', content: buildOverviewPrompt(data) }],
    stream:   false,
  });

  return (res.message?.content || '').trim() || 'Análise não disponível.';
}

module.exports = { streamAnalysis, completeAnalysis, completeOverviewAnalysis, buildPrompt, computeVerdict, streamOverviewAnalysis };
