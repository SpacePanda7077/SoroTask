import fetch from "node-fetch";

export class GasMonitor {
  constructor(logger) {
    this.logger = logger;

    this.GAS_WARN_THRESHOLD =
      parseInt(process.env.GAS_WARN_THRESHOLD, 10) || 500;

    this.ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || null;

    this.ALERT_DEBOUNCE_MS =
      parseInt(process.env.ALERT_DEBOUNCE_MS, 10) || 3600000;

    this.lastAlertTimestamps = new Map();
    this.tasksLowGasCount = 0;
    this.lowGasTasks = new Set();
  }

  async checkGasBalance(taskId, gasBalance) {
    const shouldSkip = gasBalance <= 0;
    const isLowGas = gasBalance < this.GAS_WARN_THRESHOLD && gasBalance > 0;

    const wasLowGas = this.lowGasTasks.has(taskId);

    if (isLowGas && !wasLowGas) {
      this.lowGasTasks.add(taskId);
      this.tasksLowGasCount++;
    } else if (!isLowGas && wasLowGas) {
      this.lowGasTasks.delete(taskId);
      this.tasksLowGasCount = Math.max(0, this.tasksLowGasCount - 1);
    }

    if (gasBalance <= 0) {
      this.logger.error("Critical gas balance", {
        taskId,
        gasBalance,
      });
    } else if (isLowGas) {
      this.logger.info("Low gas balance", {
        taskId,
        gasBalance,
      });
    }

    if (this.ALERT_WEBHOOK_URL && (gasBalance <= 0 || isLowGas)) {
      await this.sendWebhookAlert(taskId, gasBalance);
    }

    return shouldSkip;
  }

  async sendWebhookAlert(taskId, gasBalance) {
    const last = this.lastAlertTimestamps.get(taskId);
    const now = Date.now();

    if (last && now - last < this.ALERT_DEBOUNCE_MS) return;

    try {
      const payload = {
        event: "low_gas",
        taskId: taskId.toString(),
        gasBalance,
        timestamp: new Date().toISOString(),
      };

      const res = await fetch(this.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        this.logger.info("Webhook alert sent", {
          taskId,
        });
        this.lastAlertTimestamps.set(taskId, now);
      } else {
        this.logger.error("Webhook failed", {
          taskId,
          status: res.status,
        });
      }
    } catch (err) {
      this.logger.error("Webhook error", {
        taskId,
        error: err.message,
      });
    }
  }

  getLowGasCount() {
    return this.tasksLowGasCount;
  }

  getConfig() {
    return {
      gasWarnThreshold: this.GAS_WARN_THRESHOLD,
      alertWebhookEnabled: !!this.ALERT_WEBHOOK_URL,
      alertDebounceMs: this.ALERT_DEBOUNCE_MS,
    };
  }
}
