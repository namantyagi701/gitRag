const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { neon } = require("@neondatabase/serverless");

async function main() {
  const sql = neon(process.env.DATABASE_URL);
  const sqlFilePath = path.join(__dirname, "..", "prisma", "sql", "extensions.sql");
  const rawSql = fs.readFileSync(sqlFilePath, "utf8");

  console.log("Applying PostgreSQL-specific extensions and indexes from extensions.sql...");

  // 1. Extensions
  console.log("1/4: Ensuring vector and pg_trgm extensions...");
  await sql.query("CREATE EXTENSION IF NOT EXISTS vector;");
  await sql.query("CREATE EXTENSION IF NOT EXISTS pg_trgm;");

  // 2. search_vector column
  console.log("2/4: Checking / adding search_vector generated column...");
  await sql.query(`
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
  `);

  // 3. GIN index
  console.log("3/4: Creating GIN index on search_vector...");
  await sql.query("CREATE INDEX IF NOT EXISTS idx_symbols_search ON symbols USING GIN (search_vector);");

  // 4. HNSW index
  console.log("4/4: Creating HNSW index on embedding (vector_cosine_ops)...");
  await sql.query("CREATE INDEX IF NOT EXISTS idx_symbols_embedding ON symbols USING hnsw (embedding vector_cosine_ops);");

  console.log("All extensions, generated columns, and indexes successfully applied!");
}

main().catch((err) => {
  console.error("Failed to apply extensions:", err);
  process.exit(1);
});
