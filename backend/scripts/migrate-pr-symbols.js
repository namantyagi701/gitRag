const { neon } = require("@neondatabase/serverless");
require("dotenv").config();

async function main() {
  const sql = neon(process.env.DATABASE_URL);
  console.log("Updating pr_changed_symbols schema in database...");

  // 1. Drop not null on symbol_id
  await sql.query(`ALTER TABLE pr_changed_symbols ALTER COLUMN symbol_id DROP NOT NULL;`);
  console.log("- Set symbol_id to nullable.");

  // 2. Add symbol_name and file_path
  await sql.query(`ALTER TABLE pr_changed_symbols ADD COLUMN IF NOT EXISTS symbol_name TEXT;`);
  await sql.query(`ALTER TABLE pr_changed_symbols ADD COLUMN IF NOT EXISTS file_path TEXT;`);
  console.log("- Added symbol_name and file_path columns.");

  // 3. Update FK constraint to ON DELETE SET NULL
  await sql.query(`ALTER TABLE pr_changed_symbols DROP CONSTRAINT IF EXISTS pr_changed_symbols_symbol_id_fkey;`);
  await sql.query(`
    ALTER TABLE pr_changed_symbols 
    ADD CONSTRAINT pr_changed_symbols_symbol_id_fkey 
    FOREIGN KEY (symbol_id) REFERENCES symbols(id) ON DELETE SET NULL;
  `);
  console.log("- Updated symbol_id foreign key constraint to ON DELETE SET NULL.");

  console.log("Migration complete!");
}

main().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
