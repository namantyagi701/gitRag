const jwt = require("jsonwebtoken");

/**
 * Middleware: requireAuth
 * Reads the JWT cookie ('token'), verifies it against SESSION_SECRET,
 * and attaches req.user = { id: payload.userId }.
 * Returns 401 if missing, expired, or invalid.
 */
function requireAuth(req, res, next) {
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

    req.user = { id: decoded.userId };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized: Invalid or expired session token" });
  }
}

module.exports = requireAuth;
