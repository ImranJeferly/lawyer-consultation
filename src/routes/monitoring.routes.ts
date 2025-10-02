import { Router, Request, Response } from 'express';
import performanceMonitor from '../middleware/performance.middleware';

const router = Router();

/**
 * GET /api/monitoring/metrics
 * Get current performance metrics
 */
router.get('/metrics', (req: Request, res: Response) => {
  try {
    const metrics = performanceMonitor.getMetrics();
    res.json({
      success: true,
      data: metrics,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting performance metrics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve performance metrics',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

/**
 * GET /api/monitoring/report
 * Get formatted performance report
 */
router.get('/report', (req: Request, res: Response) => {
  try {
    const report = performanceMonitor.generateReport();
    res.json({
      success: true,
      report,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error generating performance report:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate performance report',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

/**
 * GET /api/monitoring/health
 * Get system health status
 */
router.get('/health', (req: Request, res: Response) => {
  try {
    const metrics = performanceMonitor.getMetrics();
    const healthData = {
      status: metrics.healthStatus,
      uptime: metrics.uptime,
      memory: metrics.memoryUsage,
      performance: {
        requestCount: metrics.requestCount,
        averageResponseTime: metrics.averageResponseTime,
        errorCount: metrics.errorCount,
        slowRequestCount: metrics.slowRequests.length
      },
      timestamp: metrics.timestamp
    };

    // Set appropriate HTTP status based on health
    const statusCode = metrics.healthStatus === 'critical' ? 503 :
                      metrics.healthStatus === 'warning' ? 200 : 200;

    res.status(statusCode).json({
      success: true,
      health: healthData
    });
  } catch (error) {
    console.error('Error getting health status:', error);
    res.status(500).json({
      success: false,
      message: 'Health check failed',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

/**
 * POST /api/monitoring/reset
 * Reset performance metrics (for testing)
 */
router.post('/reset', (req: Request, res: Response) => {
  try {
    performanceMonitor.reset();
    res.json({
      success: true,
      message: 'Performance metrics reset successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error resetting performance metrics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset performance metrics',
      error: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

export default router;