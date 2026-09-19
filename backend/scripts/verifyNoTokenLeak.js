require("dotenv").config();
const fs = require("fs");
const path = require("path");
const prisma = require("../src/db/prisma");
const { ensureLocalClone } = require("../src/services/repoManager");

async function verify() {
  console.log("=== Verifying Token Leak Fix in repoManager.js ===\n");

  const user = await prisma.user.findFirst({
    where: { username: "namantyagi701" },
  });

  if (!user || !user.access_token) {
    throw new Error("User namantyagi701 with access_token not found in DB");
  }

  const owner = "namantyagi701";
  const name = "ad-gen";
  const accessToken = user.access_token;

  console.log(`Testing initial clone with transient auth header for ${owner}/${name}...`);
  const clonePath = await ensureLocalClone({ owner, name, accessToken });
  console.log(`Cloned to: ${clonePath}`);

  const gitConfigPath = path.join(clonePath, ".git", "config");
  const configContent = fs.readFileSync(gitConfigPath, "utf8");

  console.log("\n--- Cloned .git/config contents ---");
  console.log(configContent);
  console.log("-----------------------------------\n");

  if (configContent.includes(accessToken)) {
    throw new Error("❌ SECURITY FAILURE: Access token found in .git/config!");
  }

  if (configContent.includes("x-access-token")) {
    throw new Error("❌ SECURITY FAILURE: 'x-access-token' found in .git/config!");
  }

  if (configContent.includes("extraheader")) {
    throw new Error("❌ SECURITY FAILURE: 'extraheader' found in .git/config!");
  }

  const expectedUrl = `https://github.com/${owner}/${name}.git`;
  if (!configContent.includes(`url = ${expectedUrl}`)) {
    throw new Error(`❌ Expected remote url = ${expectedUrl}, but not found!`);
  }

  console.log("✔ Initial clone test passed: remote URL is clean, token was NOT persisted.");

  // Test fetch on existing clone
  console.log("\nTesting fetch with transient auth header on existing clone...");
  await ensureLocalClone({ owner, name, accessToken });

  const configContentAfterFetch = fs.readFileSync(gitConfigPath, "utf8");
  if (configContentAfterFetch.includes(accessToken) || configContentAfterFetch.includes("extraheader")) {
    throw new Error("❌ SECURITY FAILURE: Access token found in .git/config after fetch!");
  }

  console.log("✔ Fetch test passed: .git/config remains completely clean after fetch.");

  // Now test with a private repo: Algo-Arena
  console.log("\nTesting private repository clone with transient auth header (Algo-Arena)...");
  const privateName = "Algo-Arena";
  const privateClonePath = await ensureLocalClone({ owner, name: privateName, accessToken });
  const privateConfigPath = path.join(privateClonePath, ".git", "config");
  const privateConfig = fs.readFileSync(privateConfigPath, "utf8");

  console.log("\n--- Private Repo .git/config contents ---");
  console.log(privateConfig);
  console.log("-----------------------------------------\n");

  if (privateConfig.includes(accessToken) || privateConfig.includes("extraheader")) {
    throw new Error("❌ SECURITY FAILURE: Access token found in private repo .git/config!");
  }

  console.log("✔ Private repo clone test passed: authenticated and cloned successfully with ZERO token leakage.");

  // Cleanup private clone directory so it doesn't take up space
  fs.rmSync(privateClonePath, { recursive: true, force: true });
  console.log("Cleaned up temporary test clone for Algo-Arena.");

  console.log("\n🎉 ALL TOKEN LEAK VERIFICATIONS PASSED!");
  await prisma.$disconnect();
  process.exit(0);
}

verify().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exit(1);
});
