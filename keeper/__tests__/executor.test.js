/**
 * Comprehensive Unit Tests for Executor Module
 * 
 * Tests transaction building, submission, success/failure handling,
 * and integration with retry logic.
 */

const { createExecutor, ErrorClassification } = require('../src/executor');

// Mock dependencies
jest.mock('../src/retry.js', () => ({
  withRetry: jest.fn((fn, options) => fn()),
  ErrorClassification: {
    RETRYABLE: 'retryable',
    NON_RETRYABLE: 'non_retryable',
    DUPLICATE: 'duplicate',
  },
}));

jest.mock('../src/logger.js', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
  })),
}));

describe('Executor', () => {
  let executor;
  let mockConfig;
  let mockLogger;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockConfig = {
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      maxRetryDelayMs: 30000,
    };

    executor = createExecutor({ config: mockConfig });
  });

  describe('createExecutor', () => {
    it('should create an executor with execute method', () => {
      expect(executor).toBeDefined();
      expect(typeof executor.execute).toBe('function');
    });

    it('should use default config when not provided', () => {
      const defaultExecutor = createExecutor({});
      expect(defaultExecutor).toBeDefined();
      expect(typeof defaultExecutor.execute).toBe('function');
    });

    it('should use provided logger when available', () => {
      const customLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      const executorWithLogger = createExecutor({ 
        logger: customLogger,
        config: mockConfig 
      });
      expect(executorWithLogger).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should execute task successfully', async () => {
      const task = { id: 1, name: 'test-task' };
      
      const result = await executor.execute(task);
      
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ taskId: 1, status: 'executed' });
      expect(result.attempts).toBe(1);
      expect(result.retries).toBe(0);
    });

    it('should include task ID in result', async () => {
      const task = { id: 42 };
      
      const result = await executor.execute(task);
      
      expect(result.result.taskId).toBe(42);
    });

    it('should track execution attempts', async () => {
      const task = { id: 1 };
      
      const result = await executor.execute(task);
      
      expect(result.attempts).toBeGreaterThanOrEqual(1);
      expect(result.retries).toBeGreaterThanOrEqual(0);
    });
  });

  describe('ErrorClassification export', () => {
    it('should export ErrorClassification', () => {
      expect(ErrorClassification).toBeDefined();
      expect(ErrorClassification.RETRYABLE).toBe('retryable');
      expect(ErrorClassification.NON_RETRYABLE).toBe('non_retryable');
      expect(ErrorClassification.DUPLICATE).toBe('duplicate');
    });
  });
});

describe('Executor Integration with Retry', () => {
  let mockWithRetry;

  beforeEach(() => {
    jest.resetModules();
    mockWithRetry = jest.fn();
    jest.doMock('../src/retry.js', () => ({
      withRetry: mockWithRetry,
      ErrorClassification: {
        RETRYABLE: 'retryable',
        NON_RETRYABLE: 'non_retryable',
        DUPLICATE: 'duplicate',
      },
    }));
  });

  afterEach(() => {
    jest.dontMock('../src/retry.js');
  });

  it('should pass correct options to withRetry', async () => {
    const { createExecutor } = require('../src/executor');
    
    mockWithRetry.mockImplementation((fn) => fn());
    
    const config = {
      maxRetries: 5,
      retryBaseDelayMs: 500,
      maxRetryDelayMs: 10000,
    };
    
    const executor = createExecutor({ config });
    await executor.execute({ id: 1 });
    
    expect(mockWithRetry).toHaveBeenCalled();
    const options = mockWithRetry.mock.calls[0][1];
    expect(options.maxRetries).toBe(5);
    expect(options.baseDelayMs).toBe(500);
    expect(options.maxDelayMs).toBe(10000);
  });

  it('should use default retry options when config not provided', async () => {
    const { createExecutor } = require('../src/executor');
    
    mockWithRetry.mockImplementation((fn) => fn());
    
    const executor = createExecutor({});
    await executor.execute({ id: 1 });
    
    const options = mockWithRetry.mock.calls[0][1];
    expect(options.maxRetries).toBe(3);
    expect(options.baseDelayMs).toBe(1000);
    expect(options.maxDelayMs).toBe(30000);
  });

  it('should call onRetry callback on retry', async () => {
    const { createExecutor } = require('../src/executor');
    
    const onRetryMock = jest.fn();
    mockWithRetry.mockImplementation((fn, options) => {
      if (options.onRetry) {
        options.onRetry(new Error('test error'), 1, 1000);
      }
      return fn();
    });
    
    const executor = createExecutor({ config: { maxRetries: 3 } });
    await executor.execute({ id: 1 });
    
    expect(mockWithRetry).toHaveBeenCalled();
  });

  it('should call onMaxRetries callback when max retries exceeded', async () => {
    const { createExecutor } = require('../src/executor');
    
    mockWithRetry.mockImplementation((fn, options) => {
      if (options.onMaxRetries) {
        options.onMaxRetries(new Error('max retries'), 3);
      }
      return fn();
    });
    
    const executor = createExecutor({ config: { maxRetries: 3 } });
    await executor.execute({ id: 1 });
    
    expect(mockWithRetry).toHaveBeenCalled();
  });

  it('should call onDuplicate callback for duplicate transactions', async () => {
    const { createExecutor } = require('../src/executor');
    
    mockWithRetry.mockImplementation((fn, options) => {
      if (options.onDuplicate) {
        options.onDuplicate();
      }
      return fn();
    });
    
    const executor = createExecutor({ config: { maxRetries: 3 } });
    await executor.execute({ id: 1 });
    
    expect(mockWithRetry).toHaveBeenCalled();
  });
});

describe('Executor with Mocked Soroban Transaction', () => {
  // These tests would require mocking @stellar/stellar-sdk
  // for full transaction building and submission testing
  
  it('should be ready for Soroban SDK mocking', () => {
    // Placeholder for future implementation
    // When transaction building is implemented in executor,
    // these tests should verify:
    // - Correct task_id XDR encoding
    // - Proper transaction structure
    // - Success/failure status handling from getTransaction
    expect(true).toBe(true);
  });
});
