const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const constraints = await prisma.$queryRawUnsafe(`
    SELECT conname, confdeltype 
    FROM pg_constraint 
    WHERE conrelid = 'pr_impacts'::regclass;
  `);
  console.log("Current constraints on pr_impacts:", constraints);

  // confdeltype: 'a' = NO ACTION, 'r' = RESTRICT, 'c' = CASCADE, 'n' = SET NULL
  // If pr_impacts_impacted_symbol_id_fkey is RESTRICT ('r') or NO ACTION ('a'), alter it to CASCADE (or SET NULL)
  // Let's alter foreign key constraint to CASCADE to match schema.prisma
  console.log("Altering pr_impacts_impacted_symbol_id_fkey to ON DELETE CASCADE...");
  await prisma.$executeRawUnsafe(`
    ALTER TABLE pr_impacts 
    DROP CONSTRAINT IF EXISTS pr_impacts_impacted_symbol_id_fkey;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE pr_impacts 
    ADD CONSTRAINT pr_impacts_impacted_symbol_id_fkey 
    FOREIGN KEY (impacted_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE;
  `);

  // Also check pr_impacts_source_symbol_id_fkey:
  console.log("Altering pr_impacts_source_symbol_id_fkey to ON DELETE SET NULL...");
  await prisma.$executeRawUnsafe(`
    ALTER TABLE pr_impacts 
    DROP CONSTRAINT IF EXISTS pr_impacts_source_symbol_id_fkey;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE pr_impacts 
    ADD CONSTRAINT pr_impacts_source_symbol_id_fkey 
    FOREIGN KEY (source_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL;
  `);

  const updated = await prisma.$queryRawUnsafe(`
    SELECT conname, confdeltype 
    FROM pg_constraint 
    WHERE conrelid = 'pr_impacts'::regclass;
  `);
  console.log("Updated constraints on pr_impacts:", updated);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
