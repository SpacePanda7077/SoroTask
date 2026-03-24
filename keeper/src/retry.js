/**
 * Error classifications for retry logic
 */
const ErrorClassification = {
  RETRYABLE: 'retryable',
  NON_RETRYABLE: 'non_retryable',
  DUPLICATE: 'duplicate',
};

/**
 * Soroban RPC error codes that indicate retryable conditions
 */
const RETRYABLE_ERROR_CODES = [
  'TIMEOUT',           // Request timeout
  'NETWORK_ERROR',     // Network connectivity issues
  'RATE_LIMITED',      // Rate limiting from RPC
  'SERVER_ERROR',      // Transient server errors
  'SERVICE_UNAVAILABLE', // Service temporarily unavailable
  'TIMEOUT_ERROR',     // Transaction submission timeout
  'TX_BAD_SEQ',        // Bad sequence number (can retry with fresh sequence)
  'TX_INSUFFICIENT_BALANCE', // Might be transient if funding is pending
];

/**
 * Soroban RPC error codes that indicate non-retryable conditions
 */
const NON_RETRYABLE_ERROR_CODES = [
  'INVALID_ARGS',      // Invalid arguments to contract
  'INSUFFICIENT_GAS',  // Not enough gas for execution
  'CONTRACT_PANIC',    // Contract execution panic
  'INVALID_TRANSACTION', // Malformed transaction
  'TX_INSUFFICIENT_FEE', // Fee too low (would need rebuild)
  'TX_BAD_AUTH',       // Bad authorization
  'TX_BAD_AUTH_EXTRA', // Extra authorization issues
  'TX_TOO_EARLY',      // Transaction valid before current ledger
  'TX_TOO_LATE',       // Transaction valid until passed
  'TX_MISSING_OPERATION', // No operations in transaction
  'TX_NOT_SUPPORTED',  // Operation not supported
];

/**
 * Error codes indicating duplicate transaction (already accepted)
 */
const DUPLICATE_ERROR_CODES = [
  'DUPLICATE_TRANSACTION',
  'TX_ALREADY_IN_LEDGER',
  'TX_DUPLICATE',
];

/**
 * Classify an error based on its code or message
 * @param {Error} error - The error to classify
 * @returns {string} - ErrorClassification value
 */
function classifyError(error) {
  if (!error) return ErrorClassification.NON_RETRYABLE;

  const errorCode = error.code || error.errorCode || extractErrorCode(error);
  const errorMessage = error.message || error.resultXdr || '';

  // Check for duplicate transaction indicators
  if (DUPLICATE_ERROR_CODES.some(code => 
    errorCode === code || 
    errorMessage.includes(code) ||
    errorMessage.includes('duplicate') ||
    errorMessage.includes('already in ledger')
  )) {
    return ErrorClassification.DUPLICATE;
  }

  // Check for non-retryable errors
  if (NON_RETRYABLE_ERROR_CODES.some(code => 
    errorCode === code || 
    errorMessage.includes(code)
  )) {
    return ErrorClassification.NON_RETRYABLE;
  }

  // Check for retryable errors
  if (RETRYABLE_ERROR_CODES.some(code => 
    errorCode === code || 
    errorMessage.includes(code)
  )) {
    return ErrorClassification.RETRYABLE;
  }

  // Default to retryable for unknown network/transient errors
  // This includes generic network errors, timeouts, etc.
  if (errorMessage.includes('timeout') ||
      errorMessage.includes('network') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('ETIMEDOUT') ||
      errorMessage.includes('ENOTFOUND') ||
      errorMessage.includes('socket hang up') ||
      errorMessage.includes('fetch failed')) {
    return ErrorClassification.RETRYABLE;
  }

  return ErrorClassification.NON_RETRYABLE;
}

/**
 * Extract error code from various error formats
 * @param {Error} error - The error object
 * @returns {string|null} - Extracted error code or null
 */
function extractErrorCode(error) {
  if (error.resultXdr) {
    // Try to extract from resultXdr if available
    const xdrStr = error.resultXdr.toString ? error.resultXdr.toString() : String(error.resultXdr);
    // Common XDR error patterns
    const patterns = ['txBadSeq', 'txInsufficientBalance', 'txInsufficientFee', 'txBadAuth'];
    for (const pattern of patterns) {
      if (xdrStr.includes(pattern)) return pattern.toUpperCase();
    }
  }
  return null;
}

/**
 * Calculate delay with exponential backoff and jitter
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {number} baseDelay - Base delay in milliseconds
 * @param {number} maxDelay - Maximum delay in milliseconds
 * @returns {number} - Calculated delay with jitter
 */
function calculateDelay(attempt, baseDelay, maxDelay) {
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  
  // Cap at maxDelay
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  
  // Add jitter: random value between 0 and baseDelay
  // This prevents thundering herd on shared RPC nodes
  const jitter = Math.random() * baseDelay;
  
  return Math.floor(cappedDelay + jitter);
}

/**
 * Sleep for a given number of milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Default options for withRetry
 */
const DEFAULT_OPTIONS = {
  maxRetries: parseInt(process.env.MAX_RETRIES, 10) || 3,
  baseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS, 10) || 1000,
  maxDelayMs: parseInt(process.env.MAX_RETRY_DELAY_MS, 10) || 30000,
  onRetry: null,        // Callback(error, attempt) called on each retry
  onMaxRetries: null,   // Callback(error, attempts) called when max retries exceeded
  onDuplicate: null,    // Callback() called when duplicate transaction detected
};

/**
 * Generic higher-order async retry wrapper with exponential backoff and jitter
 * 
 * @param {Function} fn - The async function to wrap
 * @param {Object} options - Retry configuration options
 * @param {number} options.maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} options.baseDelayMs - Base delay in milliseconds (default: 1000)
 * @param {number} options.maxDelayMs - Maximum delay cap in milliseconds (default: 30000)
 * @param {Function} options.onRetry - Callback(error, attempt) called on each retry
 * @param {Function} options.onMaxRetries - Callback(error, attempts) called when max retries exceeded
 * @param {Function} options.onDuplicate - Callback() called when duplicate transaction detected
 * @returns {Promise<*>} - Result of the wrapped function
 * @throws {Error} - Last error if all retries are exhausted
 */
export async function withRetry(fn, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError;
  let attempt = 0;

  while (attempt <= opts.maxRetries) {
    try {
      const result = await fn();
      return {
        success: true,
        result,
        attempts: attempt + 1,
        retries: attempt,
      };
    } catch (error) {
      lastError = error;
      const classification = classifyError(error);

      // Handle duplicate transaction - treat as success
      if (classification === ErrorClassification.DUPLICATE) {
        if (opts.onDuplicate) {
          opts.onDuplicate();
        }
        return {
          success: true,
          result: null,
          attempts: attempt + 1,
          retries: attempt,
          duplicate: true,
        };
      }

      // Handle non-retryable errors - bail immediately
      if (classification === ErrorClassification.NON_RETRYABLE) {
        throw {
          success: false,
          error,
          attempts: attempt + 1,
          retries: attempt,
          classification: ErrorClassification.NON_RETRYABLE,
        };
      }

      // Check if we've exhausted retries
      if (attempt >= opts.maxRetries) {
        if (opts.onMaxRetries) {
          opts.onMaxRetries(error, attempt + 1);
        }
        throw {
          success: false,
          error,
          attempts: attempt + 1,
          retries: attempt,
          classification: ErrorClassification.RETRYABLE,
          maxRetriesExceeded: true,
        };
      }

      // Calculate delay with exponential backoff and jitter
      const delay = calculateDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);

      // Call retry callback if provided
      if (opts.onRetry) {
        opts.onRetry(error, attempt + 1, delay);
      }

      // Wait before retrying
      await sleep(delay);

      attempt++;
    }
  }

  // Should never reach here, but just in case
  throw {
    success: false,
    error: lastError,
    attempts: attempt + 1,
    retries: attempt,
    maxRetriesExceeded: true,
  };
}

/**
 * Legacy retry function for backward compatibility
 * Simple retry with fixed delay
 * 
 * @param {Function} fn - The async function to retry
 * @param {number} attempts - Maximum number of attempts
 * @param {number} delay - Delay between attempts in milliseconds
 * @returns {Promise<*>}
 */
export async function retry(fn, attempts = 3, delay = 1000) {
  return withRetry(fn, {
    maxRetries: attempts - 1,
    baseDelayMs: delay,
    maxDelayMs: delay,
  }).then(result => result.result);
}

/**
 * Check if an error is retryable
 * @param {Error} error - The error to check
 * @returns {boolean} - True if the error is retryable
 */
export function isRetryableError(error) {
  return classifyError(error) === ErrorClassification.RETRYABLE;
}

/**
 * Check if an error indicates a duplicate transaction
 * @param {Error} error - The error to check
 * @returns {boolean} - True if the error indicates a duplicate
 */
export function isDuplicateTransactionError(error) {
  return classifyError(error) === ErrorClassification.DUPLICATE;
}

// Export error classifications for external use
export { ErrorClassification };
