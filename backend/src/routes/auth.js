const express = require("express");
const jwt = require("jsonwebtoken");
const { Octokit } = require("@octokit/rest");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

const COOKIE_NAME = "token";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * GET /auth/github/login
 * Redirects to GitHub OAuth authorization screen with scope=repo.
 */
router.get("/github/login", (req, res) => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: "GITHUB_OAUTH_CLIENT_ID is not configured in .env" });
  }

  const callbackUrl = `${req.protocol}://${req.get("host")}/auth/github/callback`;
  const githubAuthUrl = new URL("https://github.com/login/oauth/authorize");
  githubAuthUrl.searchParams.set("client_id", clientId);
  githubAuthUrl.searchParams.set("redirect_uri", callbackUrl);
  githubAuthUrl.searchParams.set("scope", "repo");

  res.redirect(githubAuthUrl.toString());
});

/**
 * GET /auth/github/callback
 * Exchanges authorization code for an access token, fetches user profile,
 * upserts User record, signs JWT session cookie, and redirects to FRONTEND_URL.
 */
router.get("/github/callback", async (req, res) => {
  const { code } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (!code) {
    return res.status(400).json({ error: "Missing authorization code from GitHub" });
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;

  if (!clientId || !clientSecret || !sessionSecret) {
    console.error("[Auth ERROR] OAuth credentials or SESSION_SECRET not set in .env");
    return res.status(500).json({ error: "OAuth configuration error on server" });
  }

  try {
    // 1. Exchange code for access token via GitHub's token endpoint
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error || !tokenData.access_token) {
      console.error("[Auth ERROR] GitHub token exchange failed:", tokenData);
      return res.status(400).json({
        error: tokenData.error_description || "Failed to exchange code for GitHub token",
      });
    }

    const accessToken = tokenData.access_token;

    // 2. Fetch authenticated user profile using Octokit
    const octokit = new Octokit({ auth: accessToken });
    const { data: profile } = await octokit.rest.users.getAuthenticated();

    // 3. Upsert User in database
    // TODO: Security requirement - In a production release, access_token MUST
    // be encrypted at rest (e.g. using AES-256-GCM). Storing as plaintext is
    // accepted for v1 development only.
    const user = await prisma.user.upsert({
      where: { github_id: BigInt(profile.id) },
      update: {
        username: profile.login,
        avatar_url: profile.avatar_url,
        access_token: accessToken,
      },
      create: {
        github_id: BigInt(profile.id),
        username: profile.login,
        avatar_url: profile.avatar_url,
        access_token: accessToken,
      },
    });

    // 4. Issue signed JWT session token (7d expiration)
    const sessionToken = jwt.sign(
      { userId: user.id },
      sessionSecret,
      { expiresIn: "7d" }
    );

    // 5. Set session cookie
    res.cookie(COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
    });

    // 6. Redirect to frontend
    res.redirect(frontendUrl);
  } catch (err) {
    console.error("[Auth ERROR] GitHub OAuth callback failed:", err);
    res.status(500).json({ error: "Internal server error during authentication" });
  }
});

/**
 * GET /auth/me
 * Reads JWT cookie, verifies it, and returns the current user profile.
 */
router.get("/me", async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: "Unauthorized: Missing session token" });
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    return res.status(500).json({ error: "Server authentication misconfigured" });
  }

  try {
    const decoded = jwt.verify(token, sessionSecret);
    if (!decoded || !decoded.userId) {
      return res.status(401).json({ error: "Unauthorized: Invalid session token" });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        username: true,
        avatar_url: true,
        created_at: true,
      },
    });

    if (!user) {
      return res.status(401).json({ error: "Unauthorized: User not found" });
    }

    res.json(user);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized: Invalid or expired session token" });
  }
});

/**
 * POST /auth/logout
 * Clears the session cookie.
 */
router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });

  res.json({ success: true, message: "Logged out successfully" });
});

module.exports = router;
