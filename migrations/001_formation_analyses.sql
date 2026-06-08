-- Execute no SQL Editor do Supabase
-- Armazena a análise gerada pelo Ollama para cada par de formações

CREATE TABLE IF NOT EXISTS formation_analyses (
  -- As formações ficam em ordem alfabética (canônica)
  -- para que "4-3-3 vs 4-2-3-1" e "4-2-3-1 vs 4-3-3" compartilhem o mesmo registro
  formation_a   VARCHAR(20)  NOT NULL,
  formation_b   VARCHAR(20)  NOT NULL,
  analysis_text TEXT         NOT NULL,
  generated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (formation_a, formation_b),
  CONSTRAINT ck_canonical_order CHECK (formation_a <= formation_b)
);
