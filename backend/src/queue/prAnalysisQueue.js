/**
 * BullMQ PR Analysis Queue
 *
 * Redis Setup:
 * Using local Redis installation: Redis 8.10.1 (MSYS2 standalone port for Windows)
 * configured via process.env.REDIS_URL (defaults to redis://127.0.0.1:6379).
 */

const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null
});

const prAnalysisQueue = new Queue("pr-analysis", {
  connection
});

module.exports = {
  prAnalysisQueue,
  connection
};
