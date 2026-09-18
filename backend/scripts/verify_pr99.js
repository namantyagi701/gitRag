const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const pr = await prisma.pullRequest.findFirst({
    where: { pr_number: 99 },
    include: {
      pr_changed_symbols: true,
      pr_impacts: {
        include: {
          impacted_symbol: {
            select: {
              symbol_name: true,
              symbol_type: true,
              file: { select: { file_path: true } }
            }
          }
        },
        orderBy: [{ relation_type: "asc" }, { id: "asc" }]
      }
    }
  });

  if (!pr) {
    console.log("No PR found for #99");
    return;
  }

  console.log(`\n================ PR #99 Verification ================`);
  console.log(`PR ID: ${pr.id}, Status: ${pr.status}`);
  console.log(`Repo ID: ${pr.repo_id}, Base: ${pr.base_sha}, Head: ${pr.head_sha}`);
  console.log(`Changed Symbols Count: ${pr.pr_changed_symbols.length}`);
  pr.pr_changed_symbols.forEach((s) => {
    console.log(`  - [${s.change_type}] ${s.symbol_name} (${s.file_path})`);
  });

  console.log(`\nImpact Rows Count: ${pr.pr_impacts.length}`);
  pr.pr_impacts.forEach((imp) => {
    console.log(`  - [${imp.relation_type}] ${imp.impacted_symbol?.symbol_name} (${imp.impacted_symbol?.file?.file_path}) | Severity: ${imp.severity} | Score/Hop: ${imp.rerank_score ?? imp.hop_distance}`);
  });
}

main().finally(() => prisma.$disconnect());
