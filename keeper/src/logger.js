/**
 * Structured Logging Module for SoroTask Keeper
 * 
 * Uses pino for high-performance JSON logging with support for:
 * - Multiple log levels: trace, debug, info, warn, error, fatal
 * - Child loggers with module context
 * - Pretty-printing in development mode
 * - NDJSON output in production
 * 
 * SECURITY NOTE: Sensitive fields (keypair secrets, private keys, passwords)
 * must NEVER be logged. The logger automatically redacts common sensitive fields.
 */

const pino = require('pino');

/**
 * List of sensitive fields that should never appear in logs.
 * These are automatically redacted from log output.
 */
const SENSITIVE_FIELDS = [
  'secret',
  'secretKey',
  'privateKey',
  'password',
  'token',
  'apiKey',
  'keeperSecret',
  'KEEPER_SECRET',
  'keypair',
];

/**
 * Default log level from environment or 'info'
 */
const DEFAULT_LOG_LEVEL = process.env.LOG_LEVEL || 'info';

/**
 * Check if running in development mode
 */
const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';

/**
 * Create the base pino logger instance
 * 
 * In development: Use pretty printing for human-readable output
 * In production: Use NDJSON (newline-delimited JSON) for log aggregation
 */
function createBaseLogger() {
  const options = {
    level: DEFAULT_LOG_LEVEL,
    // Base fields included in every log entry
    base: {
      pid: process.pid,
    },
    // Redact sensitive fields
    redact: {
      paths: SENSITIVE_FIELDS,
      remove: true, // Completely remove sensitive fields rather than replacing with [Redacted]
    },
    // Custom timestamp format (ISO 8601)
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  // In development, use pretty printing if pino-pretty is available
  if (IS_DEVELOPMENT) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        messageFormat: '{module} - {msg}',
      },
    };
  }

  return pino(options);
}

// Singleton base logger instance
let baseLogger = null;

/**
 * Get or create the base logger singleton
 * @returns {Object} Pino logger instance
 */
function getBaseLogger() {
  if (!baseLogger) {
    baseLogger = createBaseLogger();
  }
  return baseLogger;
}

/**
 * Create a child logger with module context
 * 
 * @param {string} module - Module name (e.g., 'poller', 'executor', 'registry')
 * @returns {Object} Child logger with module context
 * 
 * @example
 * const logger = createLogger('poller');
 * logger.info('Polling started', { taskCount: 5 });
 * // Output: {"level":30,"time":"...","module":"poller","msg":"Polling started","taskCount":5}
 */
function createLogger(module) {
  const parent = getBaseLogger();
  
  // Create child logger with module context
  const child = parent.child({ module });
  
  // Wrap the logger to provide a consistent interface
  return {
    trace: (msg, meta = {}) => {
      child.trace(meta, msg);
    },
    debug: (msg, meta = {}) => {
      child.debug(meta, msg);
    },
    info: (msg, meta = {}) => {
      child.info(meta, msg);
    },
    warn: (msg, meta = {}) => {
      child.warn(meta, msg);
    },
    error: (msg, meta = {}) => {
      child.error(meta, msg);
    },
    fatal: (msg, meta = {}) => {
      child.fatal(meta, msg);
    },
    // Expose the raw pino logger for advanced use cases
    raw: child,
  };
}

/**
 * Create a logger for a specific module (alias for createLogger)
 * @param {string} module - Module name
 * @returns {Object} Child logger
 */
function createChildLogger(module) {
  return createLogger(module);
}

/**
 * Reinitialize the base logger with new options
 * Useful for testing or dynamic configuration changes
 * 
 * @param {Object} options - Pino options
 */
function reinitializeLogger(options = {}) {
  baseLogger = pino({
    level: options.level || DEFAULT_LOG_LEVEL,
    base: { pid: process.pid },
    redact: { paths: SENSITIVE_FIELDS, remove: true },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...options,
  });
}

/**
 * Get the current log level
 * @returns {string} Current log level
 */
function getLogLevel() {
  return getBaseLogger().level;
}

/**
 * Set the log level dynamically
 * @param {string} level - New log level (trace, debug, info, warn, error, fatal)
 */
function setLogLevel(level) {
  getBaseLogger().level = level;
}

// Export the public API
module.exports = {
  createLogger,
  createChildLogger,
  getBaseLogger,
  reinitializeLogger,
  getLogLevel,
  setLogLevel,
  SENSITIVE_FIELDS,
};
