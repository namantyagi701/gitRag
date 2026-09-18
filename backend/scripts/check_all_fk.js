const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const fks = await prisma.$queryRawUnsafe(`
    SELECT
      tc.table_name, 
      kcu.column_name, 
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      rc.delete_rule,
      tc.constraint_name
    FROM 
      information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON tc.constraint_name = rc.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = rc.constraint_name
        AND ccu.table_schema = rc.constraint_schema
    WHERE ccu.table_name = 'symbols';
  `);
  console.log("All foreign keys referencing 'symbols':", JSON.stringify(fks, null, 2));
}

main().finally(() => prisma.$disconnect());
