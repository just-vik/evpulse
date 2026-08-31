-- UserContextEmbedding: RAG context store
-- Stores precomputed weekly/monthly text summaries + pgvector embeddings.
-- HNSW index is created separately in timescale.sql (Prisma cannot manage it).

CREATE TABLE IF NOT EXISTS "user_context_embeddings" (
  "id"          BIGSERIAL       NOT NULL,
  "userId"      TEXT            NOT NULL,
  "vehicleId"   TEXT            NOT NULL,
  "periodType"  TEXT            NOT NULL,
  "periodStart" TIMESTAMP(3)    NOT NULL,
  "periodEnd"   TIMESTAMP(3)    NOT NULL,
  "insightType" TEXT            NOT NULL,
  "content"     TEXT            NOT NULL,
  "embedding"   vector(768),
  "metadata"    JSONB,
  "createdAt"   TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_context_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "uce_vehicleid_periodstart_idx"
  ON "user_context_embeddings"("vehicleId", "periodStart" DESC);
