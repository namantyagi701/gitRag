const jwt = require("jsonwebtoken");
const prisma = require("../db/prisma");

/**
 * Middleware: requireAuth
 * Reads the JWT cookie ('token'), verifies it against SESSION_SECRET,
 * and queries the database to confirm the user still exists.
 * Attaches req.user = { id: user.id }.
 * Returns 401 if missing, expired, invalid, or if user was deleted.
 */
async function requireAuth(req, res, next) {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized: Missing session token" });
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.error("[requireAuth ERROR] SESSION_SECRET is not configured in .env");
    return res.status(500).json({ error: "Authentication configuration error on server" });
  }

  try {
    const decoded = jwt.verify(token, secret);
    if (!decoded || !decoded.userId) {
      return res.status(401).json({ error: "Unauthorized: Invalid token payload" });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true },
    });

    if (!user) {
      return res.status(401).json({ error: "Unauthorized: User no longer exists" });
    }

    req.user = { id: user.id };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized: Invalid or expired session token" });
  }
}

module.exports = requireAuth;
