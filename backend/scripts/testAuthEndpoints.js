require("dotenv").config();
const http = require("http");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const authRouter = require("../src/routes/auth");
const requireAuth = require("../src/middleware/requireAuth");

const prisma = new PrismaClient();

async function runTests() {
  console.log("=== GitRAG OAuth & Auth Endpoints Test Suite ===\n");

  const app = express();
  app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173", credentials: true }));
  app.use(cookieParser());
  app.use(express.json());

  app.use("/auth", authRouter);

  // Protected route testing requireAuth middleware
  app.get("/test-protected", requireAuth, (req, res) => {
    res.json({ success: true, userId: req.user.id });
  });

  const server = http.createServer(app);
  const TEST_PORT = 3099;

  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  const baseUrl = `http://localhost:${TEST_PORT}`;

  let testUserId = null;

  try {
    // -------------------------------------------------------------
    // Test 1: GET /auth/github/login
    // -------------------------------------------------------------
    console.log("Test 1: GET /auth/github/login redirects to GitHub OAuth authorize URL");
    const loginRes = await fetch(`${baseUrl}/auth/github/login`, { redirect: "manual" });
    const location = loginRes.headers.get("location");
    console.log(`  HTTP Status: ${loginRes.status}`);
    console.log(`  Redirect Location: ${location}`);

    if (loginRes.status !== 302 || !location) {
      throw new Error(`Expected 302 redirect, got status ${loginRes.status}`);
    }

    const redirectUrl = new URL(location);
    if (redirectUrl.hostname !== "github.com" || redirectUrl.pathname !== "/login/oauth/authorize") {
      throw new Error(`Unexpected redirect URL: ${location}`);
    }

    if (redirectUrl.searchParams.get("client_id") !== process.env.GITHUB_OAUTH_CLIENT_ID) {
      throw new Error("client_id query param does not match GITHUB_OAUTH_CLIENT_ID");
    }

    if (redirectUrl.searchParams.get("scope") !== "repo") {
      throw new Error("scope query param is not 'repo'");
    }
    console.log("  ✔ PASS: Redirects to GitHub with valid client_id and scope=repo\n");

    // -------------------------------------------------------------
    // Test 2: GET /auth/me without cookie (401)
    // -------------------------------------------------------------
    console.log("Test 2: GET /auth/me without session cookie returns 401 Unauthorized");
    const unauthRes = await fetch(`${baseUrl}/auth/me`);
    console.log(`  HTTP Status: ${unauthRes.status}`);
    if (unauthRes.status !== 401) {
      throw new Error(`Expected 401, got ${unauthRes.status}`);
    }
    console.log("  ✔ PASS: Rejected unauthenticated request\n");

    // -------------------------------------------------------------
    // Test 3: GET /auth/me with invalid / tampered token (401)
    // -------------------------------------------------------------
    console.log("Test 3: GET /auth/me with forged/invalid token returns 401 Unauthorized");
    const forgedRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Cookie: "token=invalid.jwt.token" },
    });
    console.log(`  HTTP Status: ${forgedRes.status}`);
    if (forgedRes.status !== 401) {
      throw new Error(`Expected 401, got ${forgedRes.status}`);
    }
    console.log("  ✔ PASS: Rejected invalid token\n");

    // -------------------------------------------------------------
    // Test 4: Upsert test user, generate valid JWT using SESSION_SECRET, verify GET /auth/me
    // -------------------------------------------------------------
    console.log("Test 4: Upsert test user and verify GET /auth/me with valid signed JWT");
    const testGithubId = 9999888877n;
    const testUser = await prisma.user.upsert({
      where: { github_id: testGithubId },
      update: {
        username: "test_oauth_user",
        avatar_url: "https://avatars.githubusercontent.com/u/9999888877?v=4",
        access_token: "gho_test_mock_token_12345",
      },
      create: {
        github_id: testGithubId,
        username: "test_oauth_user",
        avatar_url: "https://avatars.githubusercontent.com/u/9999888877?v=4",
        access_token: "gho_test_mock_token_12345",
      },
    });
    testUserId = testUser.id;
    console.log(`  Created test user with ID: ${testUserId}`);

    const validToken = jwt.sign(
      { userId: testUserId },
      process.env.SESSION_SECRET,
      { expiresIn: "7d" }
    );

    const meRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Cookie: `token=${validToken}` },
    });
    console.log(`  HTTP Status: ${meRes.status}`);
    if (meRes.status !== 200) {
      const errText = await meRes.text();
      throw new Error(`Expected 200, got ${meRes.status}: ${errText}`);
    }
    const meData = await meRes.json();
    console.log("  User profile returned:", meData);
    if (meData.id !== testUserId || meData.username !== "test_oauth_user") {
      throw new Error("User data returned does not match expected test user");
    }
    console.log("  ✔ PASS: Valid JWT returns user profile\n");

    // -------------------------------------------------------------
    // Test 5: Test requireAuth middleware on protected route
    // -------------------------------------------------------------
    console.log("Test 5: Verify requireAuth middleware on protected endpoint");
    const protectedRes = await fetch(`${baseUrl}/test-protected`, {
      headers: { Cookie: `token=${validToken}` },
    });
    console.log(`  HTTP Status: ${protectedRes.status}`);
    if (protectedRes.status !== 200) {
      throw new Error(`Expected 200 on protected route, got ${protectedRes.status}`);
    }
    const protectedData = await protectedRes.json();
    if (protectedData.userId !== testUserId) {
      throw new Error(`Expected userId ${testUserId}, got ${protectedData.userId}`);
    }
    console.log("  ✔ PASS: requireAuth attaches req.user and allows request\n");

    // -------------------------------------------------------------
    // Test 6: POST /auth/logout clears session cookie
    // -------------------------------------------------------------
    console.log("Test 6: POST /auth/logout clears cookie");
    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { Cookie: `token=${validToken}` },
    });
    console.log(`  HTTP Status: ${logoutRes.status}`);
    const setCookie = logoutRes.headers.get("set-cookie");
    console.log(`  Set-Cookie Header: ${setCookie}`);
    if (!setCookie || (!setCookie.includes("token=;") && !setCookie.includes("Expires="))) {
      throw new Error("Set-Cookie header did not clear token");
    }
    console.log("  ✔ PASS: Logout cleared session cookie\n");

    // -------------------------------------------------------------
    // Test 7: Verify cascade deletion when user is deleted
    // -------------------------------------------------------------
    console.log("Test 7: Verify Repo relation cascade behavior");
    const testRepo = await prisma.repo.create({
      data: {
        owner: "test_oauth_user",
        name: `test-repo-${Date.now()}`,
        user_id: testUserId,
      },
    });
    console.log(`  Created associated repo ID: ${testRepo.id}`);

    await prisma.user.delete({ where: { id: testUserId } });
    testUserId = null;

    const orphanedRepo = await prisma.repo.findUnique({ where: { id: testRepo.id } });
    if (orphanedRepo !== null) {
      throw new Error("Expected associated repo to be cascade deleted when user is deleted!");
    }
    console.log("  ✔ PASS: Associated repo was cleanly cascade-deleted with user\n");

    console.log("🎉 ALL TESTS PASSED SUCCESSFULLY!");
  } finally {
    if (testUserId) {
      try {
        await prisma.user.delete({ where: { id: testUserId } });
      } catch (_) {}
    }
    await prisma.$disconnect();
    server.close();
  }
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
