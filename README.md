# Football Formation Analysis

Plataforma de análise tática de futebol baseada em dados reais de partidas. O objetivo é responder perguntas como "qual formação leva vantagem sobre outra?" ou "quais times jogam melhor com um esquema específico?" com estatísticas concretas, não com opinião.

**O que a plataforma oferece:**

- **Confronto direto (H2H):** selecione duas formações e veja o histórico completo de partidas entre elas — total de jogos, vitórias de cada lado, empates, média de gols e percentuais de aproveitamento. Os resultados são separados por campeonato, com uma análise tática textual gerada por IA.
- **Modo geral:** analise uma formação contra todas as outras. Mostra aproveitamento global, ranking dos times que mais a utilizam com sucesso, ranking das formações adversárias com maior dificuldade, e desempenho por liga.
- **Filtros de campeonato e temporada:** restrinja a análise a ligas específicas (Brasileirão, Premier League, La Liga, Bundesliga, Ligue 1, Serie A e Liga Profesional Argentina) ou a determinados anos, com os filtros salvos entre sessões.
- **Análise por liga nos times:** cada bloco de campeonato no painel de times exibe as estatísticas H2H daquela liga separadamente, facilitando comparações entre contextos táticos distintos.
- **Análise de IA:** textos táticos descritivos gerados por LLM, pré-calculados e armazenados em cache — a parte factual (quem leva vantagem) é sempre calculada no código para garantir precisão.

Os dados vêm da [API-Football](https://www.api-football.com/) e ficam num
PostgreSQL (Supabase). As análises de texto são geradas por um LLM local (Ollama)
ou pela API da Anthropic, e ficam em cache no banco — assim a produção serve o
texto pronto sem depender de um modelo em runtime.

## Stack

- **Backend local:** Node.js + Express (`server.js`)
- **Produção:** funções serverless na Vercel (`api/`)
- **Banco:** PostgreSQL (Supabase)
- **IA (análise textual):** Ollama (local) ou Anthropic Claude — resultado em cache
- **Frontend:** SPA estática vanilla (`public/index.html`)
- **Dados:** API-Football (api-sports.io)

## Como rodar

### 1. Pré-requisitos

- Node.js 20+
- Um banco PostgreSQL (ex.: projeto no [Supabase](https://supabase.com/))
- Uma chave da [API-Football](https://dashboard.api-football.com/) (para popular o banco)

### 2. Instalar e configurar

```bash
git clone https://github.com/gabriel-raamos/football-formation-analysis.git
cd football-formation-analysis
npm install

cp .env.example .env        # depois preencha DATABASE_URL, API_KEY e URL
```

Veja a [tabela de variáveis](#variáveis-de-ambiente) abaixo. O mínimo para o app
subir e ler dados é a `DATABASE_URL`; para **popular** o banco você também precisa
de `API_KEY` e `URL`.

### 3. Criar as tabelas

Rode o conteúdo de [`migrations/`](migrations/) no SQL Editor do Supabase
(ou em qualquer cliente do seu Postgres). O schema de partidas/escalações já deve
existir; `migrations/001_formation_analyses.sql` cria a tabela de cache das análises.

### 4. Popular o banco (seed)

```bash
node seed.js                 # Brasileirão Série A (liga 71), todas as temporadas
node seed.js --league 39     # Premier League — ver ids abaixo
node seed.js --max-calls 50  # limita as chamadas de escalação nesta execução
```

Ligas suportadas: `71` Brasileirão · `39` Premier · `140` La Liga ·
`135` Serie A · `78` Bundesliga · `61` Ligue 1 · `128` Liga Profesional (ARG).

> A API-Football tem limite diário (100 req/dia no plano free). As **escalações**
> (que dão a formação) custam 1 chamada por partida, então populá-las leva alguns
> dias. O seed é idempotente: rode de novo no dia seguinte para continuar.

### 5. Subir o app

```bash
npm start                    # http://localhost:3000
```

## Análises de IA (opcional)

O texto da análise é **descritivo** (sem previsão/probabilidade): a parte factual
(quem leva vantagem ou se é equilíbrio) é calculada no código; o modelo só escreve
a razão tática. Tudo fica em cache na tabela `formation_analyses`.

- **Ao vivo (local):** com o [Ollama](https://ollama.com/) rodando
  (`ollama serve` + `ollama pull llama3.2`), o botão "Gerar com Ollama" cria e salva
  a análise de um confronto.
- **Pré-geração em lote (cache warming):** popula o cache de uma vez, para a
  produção (Vercel, sem Ollama) servir pronto:

  ```bash
  npm run generate-analyses -- --dry-run        # lista o que faria, sem gerar
  npm run generate-analyses                      # Ollama local (grátis)
  npm run generate-analyses -- --provider claude # API da Anthropic (paga)
  ```

  Flags: `--force` (regenera), `--min-games N`, `--limit N`, `--model <id>`.

## Deploy

- **Backend:** Vercel (funções em `api/`, `vercel.json`). Configure as variáveis
  de ambiente no painel da Vercel.
- **Frontend:** GitHub Pages (`.github/workflows/pages.yml` injeta a URL da Vercel).
- **Seed agendado:** `.github/workflows/seed.yml` roda o seed diariamente.

## Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DATABASE_URL` | sim | Conexão PostgreSQL (Supabase) |
| `API_KEY` | seed | Chave da API-Football |
| `URL` | seed | Base da API-Football (`https://v3.football.api-sports.io`) |
| `OLLAMA_URL` | não | Ollama local (default `http://localhost:11434`) |
| `OLLAMA_MODEL` | não | Modelo Ollama (default `llama3.2`) |
| `ANTHROPIC_API_KEY` | não | Só para `generate-analyses --provider claude` |
| `ANTHROPIC_MODEL` | não | Override do modelo Claude (default `claude-opus-4-8`) |
| `LEAGUE_ID` | não | Liga padrão do seed quando sem `--league` (default `71`) |
| `PORT` | não | Porta do servidor local (default `3000`) |

## Estrutura

```
server.js            Express local (/api/analysis, /api/generate, /api/leagues, /api/stats)
db.js                Pool e queries (stats por confronto, modo geral, ranking, filtro de liga)
ai.js                Geração da análise via Ollama (veredito no código + razão do modelo)
leagues.js           Mapa de campeonatos (id ↔ nome)
seed.js              Popula partidas + escalações da API-Football (parametrizável por liga)
scripts/             Pré-geração de análises (cache warming) via Ollama ou Claude
api/                 Funções serverless da Vercel (espelham os endpoints)
migrations/          SQL (tabela de cache das análises)
public/index.html    SPA (selects, barra V/E/D, leaderboard, modal de filtro)
```
