require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { neon } = require("@neondatabase/serverless");

const app = express();
const PORT = process.env.PORT || 3000;

const cookieParser = require("cookie-parser");

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);
app.use(cookieParser());
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Routes
const authRouter = require("./src/routes/auth");
app.use("/auth", authRouter);

const webhookRouter = require("./src/routes/webhook");
app.use("/webhook", webhookRouter);

const apiRouter = require("./src/routes/api");
app.use("/api/v1", apiRouter);

// Neon SQL client
const sql = process.env.DATABASE_URL
  ? neon(process.env.DATABASE_URL)
  : null;

// Health check
app.get("/", (req, res) => {
  res.send("GitRAG backend server is running!");
});

// Database test
app.get("/api/db-test", async (req, res) => {
  // Check DATABASE_URL
  if (!sql) {
    return res.status(500).json({
      success: false,
      error: "DATABASE_URL is not configured in .env",
    });
  }

  try {
    // Test database connection
    const result = await sql`SELECT version()`;

    console.log("Database connected successfully");

    res.json({
      success: true,
      message: "Connected to Neon PostgreSQL",
      version: result[0].version,
    });
  } catch (error) {
    console.error("Database query error:", error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`GitRAG backend running at http://localhost:${PORT}`);
});