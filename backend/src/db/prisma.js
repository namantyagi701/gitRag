const { PrismaClient } = require("@prisma/client");

// Shared singleton PrismaClient instance across the backend application
const prisma = new PrismaClient();

module.exports = prisma;
