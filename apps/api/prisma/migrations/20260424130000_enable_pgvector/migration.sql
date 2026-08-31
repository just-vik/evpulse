-- Enable pgvector extension for semantic embedding search (RAG)
-- Must run before any migration that creates a vector() column.
CREATE EXTENSION IF NOT EXISTS vector;
