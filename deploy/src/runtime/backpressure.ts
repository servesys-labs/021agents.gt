/**
 * Streaming backpressure controller.
 * 
 * Prevents memory exhaustion when the consumer (WebSocket client) is slower
 * than the producer (LLM stream).
 * 
 * Strategies:
 * - Buffer with size limit (drops old messages if buffer full)
 * - Pause/resume based on buffer watermarks
 * - Adaptive batching for high-throughput scenarios
 */

export interface BackpressureOptions {
  /** Maximum buffer size in bytes */
  maxBufferBytes?: number;
  /** High watermark - pause producer above this level */
  highWatermarkBytes?: number;
  /** Low watermark - resume producer below this level */
  lowWatermarkBytes?: number;
  /** Maximum messages in buffer */
  maxMessages?: number;
  /** Timeout for paused sends */
  sendTimeoutMs?: number;
  /** Whether to drop old messages when buffer full */
  dropOldOnOverflow?: boolean;
}

export interface BackpressureController {
  /** Send a message (may wait if backpressure active) */
  send(data: string): Promise<void>;
  /** Check if backpressure is active */
  isBackpressureActive(): boolean;
  /** Get current buffer stats */
  getStats(): BackpressureStats;
  /** Flush all pending messages */
  flush(): Promise<void>;
  /** Close and cleanup */
  close(): void;
}

export interface BackpressureStats {
  bufferedBytes: number;
  bufferedMessages: number;
  droppedMessages: number;
  pausedTimeMs: number;
  isPaused: boolean;
}

interface QueuedMessage {
  data: string;
  size: number;
  timestamp: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Create a backpressure controller for WebSocket streaming.
 */
export function createBackpressureController(
  underlyingSend: (data: string) => boolean | void,
  options: BackpressureOptions = {}
): BackpressureController {
  // P3 Fix: Adaptive buffer sizing — start small, grow only for fast clients.
  // At 40K concurrent clients with 10% slow, this prevents 4GB fleet memory bloat.
  // Old default: every client gets 1MB buffer = 40K × 1MB = 40GB worst case.
  // New default: start at 100KB, grow to 1MB only if client keeps up.
  const INITIAL_BUFFER = 100 * 1024;  // 100KB starting buffer
  const MAX_BUFFER = 1024 * 1024;      // 1MB max for fast clients
  const GROWTH_FACTOR = 1.5;           // Grow 50% each time we need more
  const SHRINK_THRESHOLD = 0.2;        // Shrink if buffer <20% utilized for 10s

  let adaptiveMaxBytes = options.maxBufferBytes ?? INITIAL_BUFFER;
  let lastShrinkCheck = Date.now();

  const {
    highWatermarkBytes = adaptiveMaxBytes * 0.8,
    lowWatermarkBytes = adaptiveMaxBytes * 0.3,
    maxMessages = 1000,
    sendTimeoutMs = 30000,
    dropOldOnOverflow = true,
  } = options;
  
  const queue: QueuedMessage[] = [];
  let bufferedBytes = 0;
  let droppedMessages = 0;
  let isPaused = false;
  let pausedTimeMs = 0;
  let pauseStartTime: number | null = null;
  let isClosed = false;
  let flushInterval: ReturnType<typeof setInterval> | null = null;
  
  // Start flush loop
  flushInterval = setInterval(processQueue, 5); // 5ms tick
  
  function processQueue(): void {
    if (isClosed || queue.length === 0) return;
    
    // Process as many messages as the underlying transport can take
    while (queue.length > 0) {
      const msg = queue[0];
      
      // Try to send
      const canAcceptMore = underlyingSend(msg.data);
      
      if (canAcceptMore === false) {
        // Transport backpressure - stop for now
        break;
      }
      
      // Message sent
      queue.shift();
      bufferedBytes -= msg.size;
      msg.resolve();
      
      // Check if we should resume
      if (isPaused && bufferedBytes < lowWatermarkBytes) {
        isPaused = false;
        if (pauseStartTime) {
          pausedTimeMs += Date.now() - pauseStartTime;
          pauseStartTime = null;
        }
      }
    }
  }
  
  async function send(data: string): Promise<void> {
    if (isClosed) {
      throw new Error("Backpressure controller is closed");
    }
    
    const size = new TextEncoder().encode(data).length;
    
    // Adaptive growth: if buffer is consistently full but client is consuming, grow it
    if (bufferedBytes + size > adaptiveMaxBytes && queue.length < maxMessages * 0.5) {
      // Client is consuming (queue not backed up) but needs more buffer space
      const newMax = Math.min(MAX_BUFFER, Math.ceil(adaptiveMaxBytes * GROWTH_FACTOR));
      if (newMax > adaptiveMaxBytes) {
        adaptiveMaxBytes = newMax;
      }
    }

    // Adaptive shrink: if buffer is mostly empty for 10s, reclaim memory
    const now = Date.now();
    if (now - lastShrinkCheck > 10_000) {
      lastShrinkCheck = now;
      if (bufferedBytes < adaptiveMaxBytes * SHRINK_THRESHOLD && adaptiveMaxBytes > INITIAL_BUFFER) {
        adaptiveMaxBytes = Math.max(INITIAL_BUFFER, Math.ceil(adaptiveMaxBytes * 0.5));
      }
    }

    // Check if we need to drop old messages
    if (bufferedBytes + size > adaptiveMaxBytes || queue.length >= maxMessages) {
      if (dropOldOnOverflow && queue.length > 0) {
        // Drop oldest messages until we have room
        while ((bufferedBytes + size > adaptiveMaxBytes || queue.length >= maxMessages) && queue.length > 0) {
          const dropped = queue.shift()!;
          bufferedBytes -= dropped.size;
          dropped.reject(new Error("Message dropped due to backpressure"));
          droppedMessages++;
        }
        // Notify client that messages were dropped
        if (droppedMessages > 0 && droppedMessages % 10 === 0) {
          try {
            underlyingSend(JSON.stringify({
              type: "warning",
              message: `${droppedMessages} events dropped due to slow connection. Some tool progress may be missing.`,
              ts: Date.now(),
            }));
          } catch {}
        }
      } else {
        throw new Error("Buffer overflow - message rejected");
      }
    }
    
    // Create promise for this message
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = queue.findIndex(m => m.resolve === resolve);
        if (idx !== -1) {
          const msg = queue.splice(idx, 1)[0];
          bufferedBytes -= msg.size;
          reject(new Error("Send timeout"));
        }
      }, sendTimeoutMs);
      
      const wrappedResolve = () => {
        clearTimeout(timeoutId);
        resolve();
      };
      
      const wrappedReject = (err: Error) => {
        clearTimeout(timeoutId);
        reject(err);
      };
      
      queue.push({
        data,
        size,
        timestamp: Date.now(),
        resolve: wrappedResolve,
        reject: wrappedReject,
      });
      
      bufferedBytes += size;
      
      // Check for backpressure (use adaptive max, not fixed highWatermark)
      if (bufferedBytes > adaptiveMaxBytes * 0.8 && !isPaused) {
        isPaused = true;
        pauseStartTime = Date.now();
      }
    });
  }
  
  function isBackpressureActive(): boolean {
    return isPaused || queue.length > maxMessages * 0.5;
  }
  
  function getStats(): BackpressureStats {
    return {
      bufferedBytes,
      bufferedMessages: queue.length,
      droppedMessages,
      pausedTimeMs: isPaused && pauseStartTime 
        ? pausedTimeMs + (Date.now() - pauseStartTime) 
        : pausedTimeMs,
      isPaused,
    };
  }
  
  async function flush(): Promise<void> {
    while (queue.length > 0 && !isClosed) {
      processQueue();
      if (queue.length > 0) {
        await new Promise(r => setTimeout(r, 10));
      }
    }
  }
  
  function close(): void {
    isClosed = true;
    if (flushInterval) {
      clearInterval(flushInterval);
      flushInterval = null;
    }
    
    // Reject all pending messages
    for (const msg of queue) {
      msg.reject(new Error("Controller closed"));
    }
    queue.length = 0;
    bufferedBytes = 0;
  }
  
  return {
    send,
    isBackpressureActive,
    getStats,
    flush,
    close,
  };
}

/**
 * Create a send function that applies backpressure for WebSocket connections.
 */
export function createWebSocketSendWithBackpressure(
  ws: { 
    send(data: string): void;
    bufferedAmount?: number;
    readyState: number;
  },
  options?: BackpressureOptions
): { send: (data: string) => Promise<void>; controller: BackpressureController } {
  const controller = createBackpressureController(
    (data) => {
      // Check WebSocket state
      if (ws.readyState !== 1) { // 1 = OPEN
        return false;
      }
      
      // Check native bufferedAmount if available
      if (ws.bufferedAmount !== undefined && ws.bufferedAmount > 1024 * 1024) {
        return false;
      }
      
      ws.send(data);
      return true;
    },
    options
  );
  
  return { send: controller.send, controller };
}

/**
 * Adaptive rate limiter for high-throughput streaming.
 * Adjusts batch size based on consumer capacity.
 */
export class AdaptiveRateLimiter {
  private targetLatencyMs: number;
  private currentBatchSize: number;
  private measurements: number[] = [];
  
  constructor(targetLatencyMs = 50, initialBatchSize = 1) {
    this.targetLatencyMs = targetLatencyMs;
    this.currentBatchSize = initialBatchSize;
  }
  
  recordLatency(latencyMs: number): void {
    this.measurements.push(latencyMs);
    
    // Keep last 10 measurements
    if (this.measurements.length > 10) {
      this.measurements.shift();
    }
    
    // Adjust batch size every 5 measurements
    if (this.measurements.length >= 5) {
      this.adjustBatchSize();
    }
  }
  
  private adjustBatchSize(): void {
    const avg = this.measurements.reduce((a, b) => a + b, 0) / this.measurements.length;
    
    if (avg > this.targetLatencyMs * 1.5) {
      // Too slow - reduce batch size
      this.currentBatchSize = Math.max(1, Math.floor(this.currentBatchSize * 0.8));
    } else if (avg < this.targetLatencyMs * 0.5 && this.currentBatchSize < 100) {
      // Fast enough - increase batch size
      this.currentBatchSize = Math.min(100, Math.ceil(this.currentBatchSize * 1.2));
    }
    
    this.measurements = [];
  }
  
  getBatchSize(): number {
    return this.currentBatchSize;
  }
}
