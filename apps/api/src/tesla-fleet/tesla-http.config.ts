import { HttpModule } from '@nestjs/axios';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { Logger } from '@nestjs/common';

/**
 * Simple circuit breaker — counts consecutive Tesla API failures.
 * After OPEN_THRESHOLD failures it enters OPEN state and rejects calls
 * immediately for RESET_AFTER_MS milliseconds, then resets to CLOSED.
 *
 * Single shared instance per process (Tesla API is a single upstream).
 */
class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private readonly logger = new Logger('TeslaCircuitBreaker');

  private readonly OPEN_THRESHOLD = 5;
  private readonly RESET_AFTER_MS = 60_000; // 1 minute

  isOpen(): boolean {
    if (Date.now() < this.openUntil) return true;
    if (this.openUntil > 0) {
      // Half-open: reset and allow one probe
      this.failures = 0;
      this.openUntil = 0;
      this.logger.log('Circuit CLOSED — probing Tesla API');
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.OPEN_THRESHOLD) {
      this.openUntil = Date.now() + this.RESET_AFTER_MS;
      this.logger.warn(
        `Circuit OPEN after ${this.failures} failures — Tesla API disabled for ${this.RESET_AFTER_MS / 1000}s`,
      );
    }
  }
}

const circuitBreaker = new CircuitBreaker();

/** Read-only circuit breaker status for diagnostics / admin endpoints */
export function getCircuitBreakerStatus(): { isOpen: boolean; openUntilMs: number } {
  return {
    isOpen:      (circuitBreaker as any).openUntil > Date.now(),
    openUntilMs: (circuitBreaker as any).openUntil,
  };
}

/**
 * Configure Tesla Fleet API HTTP client with:
 * - Automatic retry on 429 (rate limit) and 5xx errors
 * - Exponential backoff strategy
 * - Request/response logging
 * - Timeout handling
 */
export function createTeslaHttpModule() {
  return HttpModule.register({
    timeout: 30000, // 30 seconds for entire request
    maxRedirects: 5,
  });
}

/**
 * Add retry interceptor to axios instance
 * 
 * Retries on:
 * - 429 (Too Many Requests)
 * - 500-599 (Server errors)
 * - Network errors
 * 
 * Backoff: exponential with jitter
 * Max retries: 3 attempts
 */
export function addTeslaRetryInterceptor(instance: AxiosInstance): AxiosInstance {
  const logger = new Logger('TeslaHttpRetry');
  const maxRetries = 3;
  const initialDelayMs = 1000; // 1 second

  // Request interceptor — reject immediately if circuit is open
  instance.interceptors.request.use((config) => {
    if (circuitBreaker.isOpen()) {
      return Promise.reject(new Error('Tesla API circuit open — too many consecutive failures')) as any;
    }
    return config;
  });

  instance.interceptors.response.use(
    (response) => {
      circuitBreaker.recordSuccess();
      return response;
    },
    async (error: AxiosError) => {
      const config = error.config as any;
      if (!config) return Promise.reject(error);

      // Track retry count on config object
      if (!config.retryCount) {
        config.retryCount = 0;
      }

      // Don't retry if we've exceeded max retries
      if (config.retryCount >= maxRetries) {
        logger.warn(
          `Max retries exceeded for ${config.method?.toUpperCase()} ${config.url} ` +
          `(${error.response?.status || 'network error'})`
        );
        circuitBreaker.recordFailure();
        return Promise.reject(error);
      }

      // Check if error is retryable
      const isRetryable =
        error.response?.status === 429 || // Rate limit
        (error.response?.status ?? 0) >= 500 || // Server error
        error.code === 'ECONNABORTED' || // Timeout
        error.code === 'ECONNREFUSED' || // Connection refused
        error.code === 'ENOTFOUND'; // DNS error

      if (!isRetryable) {
        return Promise.reject(error);
      }

      config.retryCount++;

      // Calculate delay with exponential backoff + jitter
      // Delay = initialDelay * (2 ^ retryCount) + random(0, 1000)
      const exponentialDelay = initialDelayMs * Math.pow(2, config.retryCount - 1);
      const jitter = Math.random() * 1000;
      const totalDelay = exponentialDelay + jitter;

      logger.log(
        `Retry attempt ${config.retryCount}/${maxRetries} for ${config.method?.toUpperCase()} ${config.url} ` +
        `after ${Math.round(totalDelay)}ms (status: ${error.response?.status || 'network error'})`
      );

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, totalDelay));

      // Retry the request
      return instance.request(config);
    }
  );

  return instance;
}
