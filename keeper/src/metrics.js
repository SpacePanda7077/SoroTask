const http = require("http");

/**
 * Metrics store for tracking operational statistics.
 * Combines task execution metrics with gas monitoring metrics.
 */
class Metrics {
  constructor() {
    this.counters = {
      tasksCheckedTotal: 0,
      tasksDueTotal: 0,
      tasksExecutedTotal: 0,
      tasksFailedTotal: 0,
    };

    this.gauges = {
      avgFeePaidXlm: 0,
      lastCycleDurationMs: 0,
    };

    this.feeSamples = [];
    this.maxFeeSamples = 100;

    this.startTime = Date.now();
    this.lastPollAt = null;
    this.rpcConnected = false;
  }

  increment(key, amount = 1) {
    if (key in this.counters) {
      this.counters[key] += amount;
    }
  }

  record(key, value) {
    if (key === "avgFeePaidXlm") {
      this.feeSamples.push(value);
      if (this.feeSamples.length > this.maxFeeSamples) {
        this.feeSamples.shift();
      }
      this.gauges.avgFeePaidXlm =
        this.feeSamples.reduce((sum, v) => sum + v, 0) /
        this.feeSamples.length;
    } else if (key in this.gauges) {
      this.gauges[key] = value;
    }
  }

  updateHealth(state) {
    if (state.lastPollAt) {
      this.lastPollAt = state.lastPollAt;
    }
    if (typeof state.rpcConnected === "boolean") {
      this.rpcConnected = state.rpcConnected;
    }
  }

  snapshot() {
    return {
      ...this.counters,
      ...this.gauges,
    };
  }

  getHealthStatus(staleThreshold) {
    const now = Date.now();
    const uptimeSeconds = Math.floor((now - this.startTime) / 1000);
    const isStale =
      this.lastPollAt &&
      now - this.lastPollAt.getTime() > staleThreshold;

    return {
      status: isStale ? "stale" : "ok",
      uptime: uptimeSeconds,
      lastPollAt: this.lastPollAt ? this.lastPollAt.toISOString() : null,
      rpcConnected: this.rpcConnected,
    };
  }

  reset() {
    this.counters = {
      tasksCheckedTotal: 0,
      tasksDueTotal: 0,
      tasksExecutedTotal: 0,
      tasksFailedTotal: 0,
    };
    this.gauges = {
      avgFeePaidXlm: 0,
      lastCycleDurationMs: 0,
    };
    this.feeSamples = [];
  }
}

class MetricsServer {
  constructor(gasMonitor, logger) {
    this.gasMonitor = gasMonitor;
    this.logger = logger;
    this.port = parseInt(process.env.METRICS_PORT, 10) || 3000;
    this.healthStaleThreshold = parseInt(
      process.env.HEALTH_STALE_THRESHOLD_MS || "60000",
      10
    );
    this.server = null;
    this.metrics = new Metrics();
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.url === "/health" || req.url === "/health/") {
        this.handleHealth(res);
      } else if (req.url === "/metrics" || req.url === "/metrics/") {
        this.handleMetrics(res);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    this.server.listen(this.port, () => {
      this.logger.info(`Metrics server running on port ${this.port}`);
      this.logger.info(
        `Health endpoint: http://localhost:${this.port}/health`
      );
      this.logger.info(
        `Metrics endpoint: http://localhost:${this.port}/metrics`
      );
    });
  }

  handleHealth(res) {
    const healthStatus = this.metrics.getHealthStatus(
      this.healthStaleThreshold
    );
    const httpStatus = healthStatus.status === "stale" ? 503 : 200;

    res.writeHead(httpStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(healthStatus, null, 2));
  }

  handleMetrics(res) {
    const gasConfig = this.gasMonitor.getConfig();
    const taskMetrics = this.metrics.snapshot();

    const metricsData = {
      // Task execution metrics
      ...taskMetrics,

      // Gas monitoring metrics
      lowGasCount: this.gasMonitor.getLowGasCount(),
      gasWarnThreshold: gasConfig.gasWarnThreshold,
      alertDebounceMs: gasConfig.alertDebounceMs,
      alertWebhookEnabled: gasConfig.alertWebhookEnabled,
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(metricsData, null, 2));
  }

  updateHealth(state) {
    this.metrics.updateHealth(state);
  }

  increment(key, amount) {
    this.metrics.increment(key, amount);
  }

  record(key, value) {
    this.metrics.record(key, value);
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.logger.info("Metrics server stopped");
    }
  }
}

module.exports = { Metrics, MetricsServer };
