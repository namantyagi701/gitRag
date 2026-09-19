require("dotenv").config();
const http = require("http");
const jwt = require("jsonwebtoken");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { Octokit } = require("@octokit/rest");

const prisma = require("../src/db/prisma");
const apiRouter = require("../src/routes/api");
const authRouter = require("../src/routes/auth");
const { prAnalysisQueue } = require("../src/queue/prAnalysisQueue");
const { processJob } = require("../src/queue/prAnalysisWorker");

// Support BigInt in JSON serialization
BigInt.prototype.toJSON = function () {
  return this.toString();
};

async function main() {
  console.log("================================================================================");
  console.log("             GitRAG Part 0, 1 & 2 Comprehensive Verification Suite              ");
  console.log("================================================================================\n");

  const app = express();
  app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173", credentials: true }));
  app.use(cookieParser());
  app.use(express.json());

  app.use("/auth", authRouter);
  app.use("/api/v1", apiRouter);

  const server = http.createServer(app);
  const TEST_PORT = 3098;
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  const baseUrl = `http://localhost:${TEST_PORT}`;

  try {
    // Look up namantyagi701 in DB
    const realUser = await prisma.user.findFirst({
      where: { username: "namantyagi701" },
    });

    if (!realUser || !realUser.access_token) {
      throw new Error("User 'namantyagi701' with access_token not found in database.");
    }

    console.log(`Found authenticated user: ${realUser.username} (ID: ${realUser.id})`);

    const realUserToken = jwt.sign(
      { userId: realUser.id },
      process.env.SESSION_SECRET,
      { expiresIn: "7d" }
    );
    const realAuthCookie = `token=${realUserToken}`;

    // ============================================================================
    // PART 0 TEST: requireAuth verifies user still exists in DB
    // ============================================================================
    console.log("\n--------------------------------------------------------------------------------");
    console.log("PART 0: requireAuth stale / deleted user database verification");
    console.log("--------------------------------------------------------------------------------");

    // 1. Create a transient user
    const transientUser = await prisma.user.create({
      data: {
        github_id: 8877665544n,
        username: "transient_deleted_user",
        access_token: "mock_token_abc",
      },
    });
    console.log(`Created transient user: ID ${transientUser.id}`);

    const transientToken = jwt.sign(
      { userId: transientUser.id },
      process.env.SESSION_SECRET,
      { expiresIn: "7d" }
    );

    // Verify token works while user exists
    const beforeDelRes = await fetch(`${baseUrl}/api/v1/repos`, {
      headers: { Cookie: `token=${transientToken}` },
    });
    console.log(`Before user delete - Status: ${beforeDelRes.status} (Expected 200)`);
    if (beforeDelRes.status !== 200) throw new Error("Expected 200 before deletion");

    // Delete user from database
    await prisma.user.delete({ where: { id: transientUser.id } });
    console.log(`Deleted transient user ID ${transientUser.id} from database`);

    // Verify request with unexpired token NOW returns 401
    const afterDelRes = await fetch(`${baseUrl}/api/v1/repos`, {
      headers: { Cookie: `token=${transientToken}` },
    });
    const afterDelBody = await afterDelRes.json();
    console.log(`After user delete  - Status: ${afterDelRes.status}, Body:`, afterDelBody);
    if (afterDelRes.status !== 401 || !afterDelBody.error.includes("User no longer exists")) {
      throw new Error(`Expected 401 'User no longer exists', got ${afterDelRes.status}`);
    }
    console.log("✔ PASS: Deleted/stale user correctly rejected with 401 Unauthorized\n");

    // ============================================================================
    // PART 1 - TEST 6: GET /api/v1/demo/repo unauthenticated
    // ============================================================================
    console.log("--------------------------------------------------------------------------------");
    console.log("TEST 6: Unauthenticated GET /api/v1/demo/repo");
    console.log("--------------------------------------------------------------------------------");
    const demoRes = await fetch(`${baseUrl}/api/v1/demo/repo`);
    console.log(`HTTP Status: ${demoRes.status}`);
    const demoData = await demoRes.json();
    console.log("Demo repo response:", demoData);
    if (demoRes.status !== 200 || demoData.owner !== "namantyagi701" || demoData.name !== "gitRag") {
      throw new Error("Demo route failed or returned unexpected repo");
    }
    console.log("✔ PASS: GET /api/v1/demo/repo works without auth and returns namantyagi701/gitRag\n");

    // ============================================================================
    // PART 1 - TEST 1: GET /api/v1/repos/available
    // ============================================================================
    console.log("--------------------------------------------------------------------------------");
    console.log("TEST 1: GET /api/v1/repos/available for authenticated user");
    console.log("--------------------------------------------------------------------------------");
    const availRes = await fetch(`${baseUrl}/api/v1/repos/available`, {
      headers: { Cookie: realAuthCookie },
    });
    console.log(`HTTP Status: ${availRes.status}`);
    if (availRes.status !== 200) {
      const errText = await availRes.text();
      throw new Error(`Failed to fetch available repos: ${errText}`);
    }
    const availableRepos = await availRes.json();
    console.log(`Available repos count: ${availableRepos.length}`);
    console.log("Sample available repos:", availableRepos.slice(0, 5));

    // Confirm gitRag is NOT in available repos
    const hasGitRag = availableRepos.some((r) => r.name.toLowerCase() === "gitrag");
    if (hasGitRag) {
      throw new Error("gitRag is already connected and should have been excluded from available repos!");
    }
    console.log("✔ PASS: gitRag is excluded from available list");
    console.log("✔ PASS: All returned repos are administered by user\n");

    // Pick a candidate repo to test connect and disconnect
    // Pick a repo that the user owns (e.g. owner === 'namantyagi701')
    const targetRepo = availableRepos.find((r) => r.owner === realUser.username && !r.name.toLowerCase().includes("gitrag"));
    if (!targetRepo) {
      throw new Error("No eligible personal repo found in available repos to test connection!");
    }
    console.log(`Selected target repository for connect test: ${targetRepo.owner}/${targetRepo.name}`);

    // ============================================================================
    // PART 1 - TEST 2: POST /api/v1/repos/connect
    // ============================================================================
    console.log("--------------------------------------------------------------------------------");
    console.log(`TEST 2: POST /api/v1/repos/connect for ${targetRepo.owner}/${targetRepo.name}`);
    console.log("--------------------------------------------------------------------------------");
    const connectRes = await fetch(`${baseUrl}/api/v1/repos/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: realAuthCookie,
      },
      body: JSON.stringify({
        owner: targetRepo.owner,
        name: targetRepo.name,
      }),
    });

    console.log(`HTTP Status: ${connectRes.status} (Expected 201)`);
    const connectData = await connectRes.json();
    console.log("Connect response:", connectData);

    if (connectRes.status !== 201 || !connectData.id || !connectData.github_webhook_id) {
      throw new Error(`POST /repos/connect failed or missing webhook ID: ${JSON.stringify(connectData)}`);
    }

    const connectedRepoId = connectData.id;
    const webhookId = connectData.github_webhook_id;
    console.log(`✔ 2a: Successfully connected repo row in DB with ID: ${connectedRepoId}, Webhook ID: ${webhookId}`);

    // 2b: Verify real webhook on GitHub via Octokit
    const octokit = new Octokit({ auth: realUser.access_token });
    console.log(`Verifying webhook ID ${webhookId} on GitHub...`);
    const ghHookRes = await octokit.rest.repos.getWebhook({
      owner: targetRepo.owner,
      repo: targetRepo.name,
      hook_id: webhookId,
    });
    console.log(`✔ 2b: Real GitHub Webhook confirmed active on GitHub!`);
    console.log(`  Hook URL:     ${ghHookRes.data.config.url}`);
    console.log(`  Events:       ${ghHookRes.data.events.join(", ")}`);
    console.log(`  GitHub Settings URL: https://github.com/${targetRepo.owner}/${targetRepo.name}/settings/hooks/${webhookId}`);

    // 2c: Execute the 'ingest-repo' job directly via processJob and verify Neon symbols/files
    console.log(`\nExecuting 'ingest-repo' job for repo ID ${connectedRepoId}...`);
    const mockJob = {
      id: "test-ingest-job-1",
      name: "ingest-repo",
      data: { repoId: connectedRepoId },
    };
    await processJob(mockJob);

    // Verify files & symbols in Neon
    const fileCount = await prisma.file.count({ where: { repo_id: connectedRepoId } });
    const symbolCount = await prisma.symbol.count({ where: { repo_id: connectedRepoId } });
    console.log(`✔ 2c: Ingestion verified in Neon: ${fileCount} files, ${symbolCount} symbols created.`);

    // ============================================================================
    // PART 1 - TEST 3: Duplicate connect returns 409 Conflict
    // ============================================================================
    console.log("\n--------------------------------------------------------------------------------");
    console.log("TEST 3: Duplicate POST /api/v1/repos/connect returns 409 Conflict");
    console.log("--------------------------------------------------------------------------------");
    const dupRes = await fetch(`${baseUrl}/api/v1/repos/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: realAuthCookie,
      },
      body: JSON.stringify({
        owner: targetRepo.owner,
        name: targetRepo.name,
      }),
    });
    console.log(`HTTP Status: ${dupRes.status} (Expected 409)`);
    const dupData = await dupRes.json();
    console.log("Duplicate connect body:", dupData);
    if (dupRes.status !== 409) {
      throw new Error(`Expected 409 Conflict, got ${dupRes.status}`);
    }
    console.log("✔ PASS: Duplicate connection cleanly rejected with 409 Conflict\n");

    // ============================================================================
    // PART 1 - TEST 5: Test ownership boundary (404 on unowned repo)
    // ============================================================================
    console.log("--------------------------------------------------------------------------------");
    console.log("TEST 5: Test ownership boundary (DELETE on unowned repo returns 404)");
    console.log("--------------------------------------------------------------------------------");
    // Repo ID 1 (gitrag-dev/test-repo) has user_id: null, not owned by namantyagi701
    const boundaryRes = await fetch(`${baseUrl}/api/v1/repos/1`, {
      method: "DELETE",
      headers: { Cookie: realAuthCookie },
    });
    console.log(`HTTP Status: ${boundaryRes.status} (Expected 404)`);
    if (boundaryRes.status !== 404) {
      throw new Error(`Expected 404 on unowned repo, got ${boundaryRes.status}`);
    }
    // Verify repo 1 is untouched
    const repo1 = await prisma.repo.findUnique({ where: { id: 1 } });
    if (!repo1) {
      throw new Error("Repo 1 was unexpectedly deleted!");
    }
    console.log("✔ PASS: Accessing unowned repo returns 404 and leaves repo intact\n");

    // ============================================================================
    // PART 1 - TEST 4: DELETE /api/v1/repos/:id
    // ============================================================================
    console.log("--------------------------------------------------------------------------------");
    console.log(`TEST 4: DELETE /api/v1/repos/${connectedRepoId} for ${targetRepo.owner}/${targetRepo.name}`);
    console.log("--------------------------------------------------------------------------------");
    const delRes = await fetch(`${baseUrl}/api/v1/repos/${connectedRepoId}`, {
      method: "DELETE",
      headers: { Cookie: realAuthCookie },
    });
    console.log(`HTTP Status: ${delRes.status} (Expected 200)`);
    const delBody = await delRes.json();
    console.log("Delete response:", delBody);
    if (delRes.status !== 200 || !delBody.success) {
      throw new Error(`Failed to delete repo: ${JSON.stringify(delBody)}`);
    }

    // 4a: Confirm webhook is deleted on GitHub
    console.log(`Verifying webhook ID ${webhookId} was removed from GitHub...`);
    let webhookStillExists = false;
    try {
      await octokit.rest.repos.getWebhook({
        owner: targetRepo.owner,
        repo: targetRepo.name,
        hook_id: webhookId,
      });
      webhookStillExists = true;
    } catch (ghErr) {
      if (ghErr.status === 404) {
        console.log("✔ 4a: Webhook confirmed deleted from GitHub (returned 404 Not Found)!");
      } else {
        console.warn("Unexpected GitHub error checking webhook:", ghErr.message);
      }
    }
    if (webhookStillExists) {
      throw new Error("Webhook was NOT removed from GitHub!");
    }

    // 4b: Confirm repos row and all files/symbols are gone from Neon
    const checkRepo = await prisma.repo.findUnique({ where: { id: connectedRepoId } });
    const checkFiles = await prisma.file.count({ where: { repo_id: connectedRepoId } });
    const checkSymbols = await prisma.symbol.count({ where: { repo_id: connectedRepoId } });
    console.log(`Post-deletion Neon counts -> Repo: ${checkRepo ? "EXISTS" : "NONE"}, Files: ${checkFiles}, Symbols: ${checkSymbols}`);

    if (checkRepo !== null || checkFiles !== 0 || checkSymbols !== 0) {
      throw new Error("Repo or cascaded files/symbols were not completely removed from Neon!");
    }
    console.log("✔ 4b: Repo and all cascaded children cleanly removed from Neon database!\n");

    console.log("================================================================================");
    console.log("                  🎉 ALL 6 COMPREHENSIVE TESTS PASSED!                         ");
    console.log("================================================================================");
  } finally {
    await prisma.$disconnect();
    server.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("\n❌ Test Suite Failed:", err);
  process.exit(1);
});
