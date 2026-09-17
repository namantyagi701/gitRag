-- ============================================================================
-- GitRAG PostgreSQL-Specific Extensions, Generated Columns, and Indexes
-- This file contains only functionality that Prisma schema cannot natively generate.
-- All tables and relations are managed exclusively in prisma/schema.prisma.
-- ============================================================================

-- 1. Required PostgreSQL Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Generated Column for Full-Text Search on symbols table
-- Weights: Symbol name (A) and Docstring (B)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'symbols' AND column_name = 'search_vector'
    ) THEN
        ALTER TABLE symbols ADD COLUMN search_vector tsvector
            GENERATED ALWAYS AS (
                setweight(to_tsvector('english', coalesce(symbol_name, '')), 'A') ||
                setweight(to_tsvector('english', coalesce(docstring, '')), 'B')
            ) STORED;
    END IF;
END $$;

-- 3. GIN Index for Fast Full-Text Search
CREATE INDEX IF NOT EXISTS idx_symbols_search ON symbols USING GIN (search_vector);

-- 4. HNSW Vector Index for Fast Cosine Similarity Search on 384-dim Embeddings
CREATE INDEX IF NOT EXISTS idx_symbols_embedding ON symbols USING hnsw (embedding vector_cosine_ops);
