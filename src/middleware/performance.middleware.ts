import { Request, Response, NextFunction } from 'express';
import { performance } from 'perf_hooks';

interface PerformanceMetrics {
  requestCount: number;
  averageResponseTime: number;
  slowRequests: Array<{
    path: string;
    method: string;
    duration: number;
    timestamp: Date;
  }>;
  errorCount: number;
  memoryUsage: {
    heapTotal: number;
    heapUsed: number;
    external: number;
    rss: number;
  };
  databaseQueries: Array<{
    query: string;
    duration: number;
    timestamp: Date;
  }>;
}

class PerformanceMonitor {
  private metrics: PerformanceMetrics = {
    requestCount: 0,
    averageResponseTime: 0,
    slowRequests: [],
    errorCount: 0,
    memoryUsage: {
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      rss: 0
    },
    databaseQueries: []
  };

  private responseTimes: number[] = [];
  private readonly SLOW_REQUEST_THRESHOLD = 1000; // 1 second
  private readonly MAX_STORED_SLOW_REQUESTS = 100;
  private readonly MAX_STORED_DB_QUERIES = 100;

  // Request timing middleware
  requestTimer = (req: Request, res: Response, next: NextFunction) => {
    const startTime = performance.now();
    const monitor = this;
    
    // Override res.end to capture response time
    const originalEnd = res.end.bind(res);
    res.end = function(chunk?: any, encoding?: BufferEncoding | (() => void), cb?: () => void) {
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      // Update metrics
      monitor.updateRequestMetrics(req, duration, res.statusCode);
      
      // Call original end with proper arguments
      if (typeof encoding === 'function') {
        return originalEnd(chunk, encoding);
      } else if (encoding && cb) {
        return originalEnd(chunk, encoding, cb);
      } else if (chunk) {
        return originalEnd(chunk);
      } else {
        return originalEnd();
      }
    };

    next();
  };

  private updateRequestMetrics(req: Request, duration: number, statusCode: number) {
    this.metrics.requestCount++;
    this.responseTimes.push(duration);
    
    // Calculate average response time
    this.metrics.averageResponseTime = 
      this.responseTimes.reduce((sum, time) => sum + time, 0) / this.responseTimes.length;
    
    // Track slow requests
    if (duration > this.SLOW_REQUEST_THRESHOLD) {
      this.metrics.slowRequests.push({
        path: req.path,
        method: req.method,
        duration,
        timestamp: new Date()
      });
      
      // Keep only recent slow requests
      if (this.metrics.slowRequests.length > this.MAX_STORED_SLOW_REQUESTS) {
        this.metrics.slowRequests.shift();
      }
    }
    
    // Track errors
    if (statusCode >= 400) {
      this.metrics.errorCount++;
    }
    
    // Update memory usage
    this.updateMemoryMetrics();
  }

  private updateMemoryMetrics() {
    const memUsage = process.memoryUsage();
    this.metrics.memoryUsage = {
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),   // MB
      external: Math.round(memUsage.external / 1024 / 1024),   // MB
      rss: Math.round(memUsage.rss / 1024 / 1024)              // MB
    };
  }

  // Database query tracking
  trackDbQuery = (query: string, duration: number) => {
    this.metrics.databaseQueries.push({
      query: query.substring(0, 100), // Truncate long queries
      duration,
      timestamp: new Date()
    });
    
    // Keep only recent queries
    if (this.metrics.databaseQueries.length > this.MAX_STORED_DB_QUERIES) {
      this.metrics.databaseQueries.shift();
    }
  };

  // Get current metrics
  getMetrics(): PerformanceMetrics & {
    uptime: number;
    timestamp: Date;
    healthStatus: 'healthy' | 'warning' | 'critical';
  } {
    const healthStatus = this.determineHealthStatus();
    
    return {
      ...this.metrics,
      uptime: Math.round(process.uptime()),
      timestamp: new Date(),
      healthStatus
    };
  }

  private determineHealthStatus(): 'healthy' | 'warning' | 'critical' {
    const avgResponseTime = this.metrics.averageResponseTime;
    const memoryUsed = this.metrics.memoryUsage.heapUsed;
    const errorRate = this.metrics.requestCount > 0 ? 
      (this.metrics.errorCount / this.metrics.requestCount) * 100 : 0;
    
    // Critical conditions
    if (avgResponseTime > 5000 || memoryUsed > 512 || errorRate > 50) {
      return 'critical';
    }
    
    // Warning conditions
    if (avgResponseTime > 2000 || memoryUsed > 256 || errorRate > 20) {
      return 'warning';
    }
    
    return 'healthy';
  }

  // Reset metrics (useful for testing)
  reset() {
    this.metrics = {
      requestCount: 0,
      averageResponseTime: 0,
      slowRequests: [],
      errorCount: 0,
      memoryUsage: {
        heapTotal: 0,
        heapUsed: 0,
        external: 0,
        rss: 0
      },
      databaseQueries: []
    };
    this.responseTimes = [];
  }

  // Generate performance report
  generateReport(): string {
    const metrics = this.getMetrics();
    
    return `
🚀 PERFORMANCE REPORT
====================
⏱️  Uptime: ${metrics.uptime}s
📊 Status: ${metrics.healthStatus.toUpperCase()}
📈 Requests: ${metrics.requestCount}
⚡ Avg Response Time: ${metrics.averageResponseTime.toFixed(2)}ms
🐌 Slow Requests: ${metrics.slowRequests.length}
❌ Errors: ${metrics.errorCount}
💾 Memory Used: ${metrics.memoryUsage.heapUsed}MB / ${metrics.memoryUsage.heapTotal}MB
🗄️  Database Queries: ${metrics.databaseQueries.length}

Recent Slow Requests:
${metrics.slowRequests.slice(-5).map(req => 
  `  ${req.method} ${req.path} - ${req.duration.toFixed(2)}ms`
).join('\n') || '  None'}

Recent DB Queries:
${metrics.databaseQueries.slice(-5).map(query => 
  `  ${query.query} - ${query.duration.toFixed(2)}ms`
).join('\n') || '  None'}
`;
  }
}

export default new PerformanceMonitor();