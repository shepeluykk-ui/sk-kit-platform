/**
 * Circuit Breaker pattern for Google GenAI API calls.
 * Prevents cascading failures when GenAI API is slow or down.
 * Automatically switches to fallback/cached responses after N consecutive failures.
 */

export class GenAICircuitBreaker {
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private readonly FAILURE_THRESHOLD = 5;
  private readonly TIMEOUT_MS = 15000; // 15 second timeout
  private readonly RESET_TIMEOUT_MS = 60 * 1000; // 1 minute reset after circuit opens

  /**
   * Execute a GenAI API call with automatic fallback on timeout/error.
   * @param fn The async function to call (e.g., GenAI API call)
   * @param fallback The value to return if the circuit is open or call times out
   * @returns The result from fn, or fallback if failure threshold exceeded
   */
  async call<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    if (this.isOpen()) {
      console.warn('[GenAICircuitBreaker] Circuit is OPEN, using fallback');
      return fallback;
    }

    try {
      const result = await Promise.race([
        fn(),
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error('GenAI API timeout')), this.TIMEOUT_MS)
        )
      ]);

      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      console.error('[GenAICircuitBreaker] Call failed:', error instanceof Error ? error.message : String(error));
      return fallback;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.lastFailureTime = null;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    console.warn(`[GenAICircuitBreaker] Failure ${this.failureCount}/${this.FAILURE_THRESHOLD}`);
  }

  private isOpen(): boolean {
    // Circuit is closed if failures below threshold
    if (this.failureCount < this.FAILURE_THRESHOLD) {
      return false;
    }

    if (!this.lastFailureTime) {
      return false;
    }

    const timeSinceLastFailure = Date.now() - this.lastFailureTime;

    // Auto-reset after RESET_TIMEOUT_MS
    if (timeSinceLastFailure > this.RESET_TIMEOUT_MS) {
      console.log('[GenAICircuitBreaker] Reset timeout exceeded, attempting to close circuit');
      this.failureCount = 0;
      this.lastFailureTime = null;
      return false;
    }

    return true;
  }

  getStatus(): { isOpen: boolean; failureCount: number; lastFailureTime: string | null } {
    return {
      isOpen: this.isOpen(),
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null
    };
  }
}

export const genaiCircuitBreaker = new GenAICircuitBreaker();
