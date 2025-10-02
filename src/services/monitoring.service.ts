// ====================================================================
// SYSTEM MONITORING SERVICE
// Real-time system monitoring, alerting, and health management
// ====================================================================

import { PrismaClient } from '@prisma/client';
import {
  SystemHealth,
  SystemMetricData,
  AlertConfiguration,
  AnomalyDetection,
  ComponentHealth,
  AlertSummary,
  PerformanceTrend,
  CapacityMetrics,
  AlertProcessingError
} from '../types/analytics.types';

const prisma = new PrismaClient();

// Simple logger
const logger = {
  info: (message: string, meta?: any) => console.log(`[INFO] ${message}`, meta || ''),
  error: (message: string, meta?: any) => console.error(`[ERROR] ${message}`, meta || ''),
  warn: (message: string, meta?: any) => console.warn(`[WARN] ${message}`, meta || '')
};

export class SystemMonitoringService {
  private static instance: SystemMonitoringService;
  private monitoringEnabled = true;
  private alertThresholds = new Map<string, number>();
  private healthCheckInterval: NodeJS.Timeout | null = null;

  private constructor() {
    this.initializeMonitoring();
  }

  public static getInstance(): SystemMonitoringService {
    if (!SystemMonitoringService.instance) {
      SystemMonitoringService.instance = new SystemMonitoringService();
    }
    return SystemMonitoringService.instance;
  }

  // ====================================================================
  // SYSTEM HEALTH MONITORING
  // ====================================================================

  /**
   * Get comprehensive system health status
   */
  async getSystemHealth(): Promise<SystemHealth> {
    try {
      // Get recent system metrics (last 15 minutes)
      const recentMetrics = await prisma.systemMetrics.findMany({
        where: {
          timestamp: {
            gte: new Date(Date.now() - 15 * 60 * 1000)
          }
        },
        orderBy: { timestamp: 'desc' }
      });

      // Get active alerts
      const activeAlerts = await prisma.systemAlerts.findMany({
        where: { status: 'active' },
        orderBy: { severity: 'desc' }
      });

      // Calculate component health
      const components = await this.calculateComponentHealth(recentMetrics);
      
      // Calculate overall health score
      const overallScore = this.calculateOverallHealthScore(components, activeAlerts);
      
      // Get performance trends
      const performanceTrends = await this.getPerformanceTrends();
      
      // Get capacity metrics
      const capacityMetrics = await this.getCapacityMetrics();

      return {
        overallScore,
        components,
        activeAlerts: activeAlerts.map(alert => ({
          id: alert.id,
          severity: alert.severity as 'info' | 'warning' | 'error' | 'critical',
          title: alert.title,
          component: alert.component,
          triggeredAt: alert.triggeredAt,
          isResolved: alert.status === 'resolved'
        })),
        performanceTrends,
        capacityMetrics
      };
    } catch (error) {
      logger.error('Failed to get system health', { error });
      throw new AlertProcessingError('Failed to get system health', { error });
    }
  }

  /**
   * Calculate health score for individual components
   */
  private async calculateComponentHealth(metrics: any[]): Promise<ComponentHealth[]> {
    const componentMap = new Map<string, any[]>();
    
    // Group metrics by component
    metrics.forEach(metric => {
      if (!componentMap.has(metric.component)) {
        componentMap.set(metric.component, []);
      }
      componentMap.get(metric.component)!.push(metric);
    });

    const components: ComponentHealth[] = [];

    for (const [componentName, componentMetrics] of componentMap) {
      // Calculate response time (average of response_time metrics)
      const responseTimeMetrics = componentMetrics.filter(m => m.metricName === 'response_time');
      const avgResponseTime = responseTimeMetrics.length > 0
        ? responseTimeMetrics.reduce((sum: number, m: any) => sum + Number(m.value), 0) / responseTimeMetrics.length
        : 0;

      // Calculate error rate (percentage of error metrics)
      const errorMetrics = componentMetrics.filter(m => m.metricName === 'error_rate');
      const avgErrorRate = errorMetrics.length > 0
        ? errorMetrics.reduce((sum: number, m: any) => sum + Number(m.value), 0) / errorMetrics.length
        : 0;

      // Calculate availability (uptime percentage)
      const uptimeMetrics = componentMetrics.filter(m => m.metricName === 'uptime');
      const availability = uptimeMetrics.length > 0
        ? uptimeMetrics[uptimeMetrics.length - 1].value
        : 100;

      // Determine component status
      let status: 'healthy' | 'warning' | 'error' | 'critical' = 'healthy';
      if (avgErrorRate > 10 || avgResponseTime > 5000 || availability < 95) {
        status = 'critical';
      } else if (avgErrorRate > 5 || avgResponseTime > 2000 || availability < 98) {
        status = 'error';
      } else if (avgErrorRate > 1 || avgResponseTime > 1000 || availability < 99.5) {
        status = 'warning';
      }

      components.push({
        component: componentName,
        status,
        responseTime: avgResponseTime,
        errorRate: avgErrorRate,
        availability: Number(availability),
        lastChecked: new Date()
      });
    }

    return components;
  }

  /**
   * Calculate overall system health score
   */
  private calculateOverallHealthScore(components: ComponentHealth[], alerts: any[]): number {
    if (components.length === 0) return 100;

    // Base score from component health
    const componentScores = components.map(comp => {
      switch (comp.status) {
        case 'healthy': return 100;
        case 'warning': return 80;
        case 'error': return 60;
        case 'critical': return 20;
        default: return 100;
      }
    });

    const avgComponentScore = componentScores.reduce((sum, score) => sum + score, 0) / componentScores.length;

    // Deduct points for active alerts
    const criticalAlerts = alerts.filter(a => a.severity === 'critical').length;
    const errorAlerts = alerts.filter(a => a.severity === 'error').length;
    const warningAlerts = alerts.filter(a => a.severity === 'warning').length;

    const alertPenalty = (criticalAlerts * 20) + (errorAlerts * 10) + (warningAlerts * 5);

    return Math.max(0, Math.min(100, avgComponentScore - alertPenalty));
  }

  /**
   * Get performance trends for key metrics
   */
  private async getPerformanceTrends(): Promise<PerformanceTrend[]> {
    const trends: PerformanceTrend[] = [];
    const keyMetrics = ['response_time', 'error_rate', 'cpu_usage', 'memory_usage'];

    for (const metricName of keyMetrics) {
      try {
        // Get current period metrics (last hour)
        const currentMetrics = await prisma.systemMetrics.findMany({
          where: {
            metricName,
            timestamp: { gte: new Date(Date.now() - 60 * 60 * 1000) }
          }
        });

        // Get previous period metrics (hour before that)
        const previousMetrics = await prisma.systemMetrics.findMany({
          where: {
            metricName,
            timestamp: {
              gte: new Date(Date.now() - 2 * 60 * 60 * 1000),
              lt: new Date(Date.now() - 60 * 60 * 1000)
            }
          }
        });

        if (currentMetrics.length > 0 && previousMetrics.length > 0) {
          const currentAvg = currentMetrics.reduce((sum, m) => sum + Number(m.value), 0) / currentMetrics.length;
          const previousAvg = previousMetrics.reduce((sum, m) => sum + Number(m.value), 0) / previousMetrics.length;

          const changePercent = previousAvg > 0 ? ((currentAvg - previousAvg) / previousAvg) * 100 : 0;
          
          trends.push({
            metric: metricName,
            current: currentAvg,
            trend: changePercent > 5 ? 'up' : changePercent < -5 ? 'down' : 'stable',
            changePercent: Math.abs(changePercent),
            period: '1h'
          });
        }
      } catch (error) {
        logger.error(`Failed to calculate trend for ${metricName}`, { error });
      }
    }

    return trends;
  }

  /**
   * Get current system capacity metrics
   */
  private async getCapacityMetrics(): Promise<CapacityMetrics> {
    try {
      // Get latest capacity-related metrics
      const latestMetrics = await prisma.systemMetrics.findMany({
        where: {
          metricName: {
            in: ['cpu_usage', 'memory_usage', 'disk_usage', 'network_usage', 'db_connections']
          },
          timestamp: { gte: new Date(Date.now() - 5 * 60 * 1000) } // Last 5 minutes
        },
        orderBy: { timestamp: 'desc' }
      });

      const getLatestValue = (metricName: string): number => {
        const metric = latestMetrics.find(m => m.metricName === metricName);
        return metric ? Number(metric.value) : 0;
      };

      return {
        cpuUsage: getLatestValue('cpu_usage'),
        memoryUsage: getLatestValue('memory_usage'),
        diskUsage: getLatestValue('disk_usage'),
        networkUsage: getLatestValue('network_usage'),
        databaseConnections: getLatestValue('db_connections'),
        predictedCapacity: await this.predictCapacityUtilization()
      };
    } catch (error) {
      logger.error('Failed to get capacity metrics', { error });
      return {
        cpuUsage: 0,
        memoryUsage: 0,
        diskUsage: 0,
        networkUsage: 0,
        databaseConnections: 0,
        predictedCapacity: 0
      };
    }
  }

  // ====================================================================
  // ALERTING SYSTEM
  // ====================================================================

  /**
   * Configure alert rule
   */
  async configureAlert(config: AlertConfiguration): Promise<void> {
    try {
      // Store alert threshold
      this.alertThresholds.set(`${config.metric}_${config.condition}`, config.threshold);
      
      logger.info('Alert configured successfully', {
        name: config.name,
        metric: config.metric,
        threshold: config.threshold
      });
    } catch (error) {
      logger.error('Failed to configure alert', { error, config });
      throw new AlertProcessingError('Failed to configure alert', { error });
    }
  }

  /**
   * Check metric against alert conditions
   */
  async checkAlertConditions(metricData: SystemMetricData): Promise<void> {
    try {
      const alertKey = `${metricData.metricName}_greater_than`;
      const threshold = this.alertThresholds.get(alertKey);

      if (threshold && metricData.value > threshold) {
        await this.triggerAlert({
          name: `High ${metricData.metricName}`,
          type: 'performance',
          severity: metricData.alertLevel || 'warning',
          title: `${metricData.metricName} exceeded threshold`,
          description: `${metricData.metricName} value ${metricData.value} exceeded threshold ${threshold}`,
          component: metricData.component,
          metricName: metricData.metricName,
          threshold,
          actualValue: metricData.value,
          condition: 'greater_than'
        });
      }
    } catch (error) {
      logger.error('Failed to check alert conditions', { error, metricData });
    }
  }

  /**
   * Trigger system alert
   */
  private async triggerAlert(alertData: {
    name: string;
    type: string;
    severity: string;
    title: string;
    description: string;
    component: string;
    metricName: string;
    threshold: number;
    actualValue: number;
    condition: string;
  }): Promise<void> {
    try {
      // Check if similar alert already exists
      const existingAlert = await prisma.systemAlerts.findFirst({
        where: {
          alertName: alertData.name,
          component: alertData.component,
          status: 'active'
        }
      });

      if (existingAlert) {
        // Update occurrence count
        await prisma.systemAlerts.update({
          where: { id: existingAlert.id },
          data: {
            occurrenceCount: { increment: 1 },
            lastOccurrence: new Date(),
            actualValue: alertData.actualValue
          }
        });
      } else {
        // Create new alert
        await prisma.systemAlerts.create({
          data: {
            alertName: alertData.name,
            alertType: alertData.type,
            severity: alertData.severity,
            title: alertData.title,
            description: alertData.description,
            component: alertData.component,
            metricName: alertData.metricName,
            threshold: alertData.threshold,
            actualValue: alertData.actualValue,
            condition: alertData.condition,
            status: 'active',
            firstOccurrence: new Date(),
            lastOccurrence: new Date(),
            triggeredAt: new Date()
          }
        });
      }

      logger.warn('Alert triggered', {
        name: alertData.name,
        component: alertData.component,
        value: alertData.actualValue,
        threshold: alertData.threshold
      });

      // Send notifications (would integrate with notification service)
      await this.sendAlertNotifications(alertData);
    } catch (error) {
      logger.error('Failed to trigger alert', { error, alertData });
    }
  }

  /**
   * Get active alerts
   */
  async getActiveAlerts(): Promise<AlertSummary[]> {
    try {
      const alerts = await prisma.systemAlerts.findMany({
        where: { status: 'active' },
        orderBy: [
          { severity: 'desc' },
          { triggeredAt: 'desc' }
        ]
      });

      return alerts.map(alert => ({
        id: alert.id,
        severity: alert.severity as 'info' | 'warning' | 'error' | 'critical',
        title: alert.title,
        component: alert.component,
        triggeredAt: alert.triggeredAt,
        isResolved: alert.status === 'resolved'
      }));
    } catch (error) {
      logger.error('Failed to get active alerts', { error });
      return [];
    }
  }

  /**
   * Acknowledge alert
   */
  async acknowledgeAlert(alertId: string, userId: string): Promise<void> {
    try {
      await prisma.systemAlerts.update({
        where: { id: alertId },
        data: {
          status: 'acknowledged',
          acknowledgedBy: userId,
          acknowledgedAt: new Date()
        }
      });

      logger.info('Alert acknowledged', { alertId, userId });
    } catch (error) {
      logger.error('Failed to acknowledge alert', { error, alertId });
      throw new AlertProcessingError('Failed to acknowledge alert', { error });
    }
  }

  /**
   * Resolve alert
   */
  async resolveAlert(alertId: string, userId: string, resolutionNotes?: string): Promise<void> {
    try {
      const alert = await prisma.systemAlerts.findUnique({
        where: { id: alertId }
      });

      if (!alert) {
        throw new Error('Alert not found');
      }

      const timeToResolution = alert.triggeredAt 
        ? Math.floor((Date.now() - alert.triggeredAt.getTime()) / (1000 * 60))
        : 0;

      await prisma.systemAlerts.update({
        where: { id: alertId },
        data: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNotes,
          timeToResolution: timeToResolution
        }
      });

      logger.info('Alert resolved', { alertId, userId, timeToResolution });
    } catch (error) {
      logger.error('Failed to resolve alert', { error, alertId });
      throw new AlertProcessingError('Failed to resolve alert', { error });
    }
  }

  // ====================================================================
  // ANOMALY DETECTION
  // ====================================================================

  /**
   * Detect anomalies in system metrics
   */
  async detectAnomalies(metricName: string, lookbackHours: number = 24): Promise<AnomalyDetection> {
    try {
      // Get historical data
      const metrics = await prisma.systemMetrics.findMany({
        where: {
          metricName,
          timestamp: { gte: new Date(Date.now() - lookbackHours * 60 * 60 * 1000) }
        },
        orderBy: { timestamp: 'asc' }
      });

      if (metrics.length < 10) {
        return { detected: false, anomalies: [], confidence: 0, recommendations: [] };
      }

      // Simple statistical anomaly detection
      const values = metrics.map(m => Number(m.value));
      const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
      const stdDev = Math.sqrt(
        values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length
      );

      const anomalies = [];
      const threshold = 2.5; // Standard deviations

      for (let i = 0; i < metrics.length; i++) {
        const value = Number(metrics[i].value);
        const zScore = Math.abs((value - mean) / stdDev);

        if (zScore > threshold) {
          anomalies.push({
            metric: metricName,
            timestamp: metrics[i].timestamp,
            expectedValue: mean,
            actualValue: value,
            severity: zScore > 3 ? 'high' : 'medium' as 'low' | 'medium' | 'high',
            description: `Unusual ${metricName} value detected (${zScore.toFixed(2)} standard deviations from mean)`
          });
        }
      }

      const confidence = anomalies.length > 0 ? Math.min(95, 70 + (anomalies.length * 5)) : 0;

      return {
        detected: anomalies.length > 0,
        anomalies,
        confidence,
        recommendations: this.generateAnomalyRecommendations(anomalies)
      };
    } catch (error) {
      logger.error('Failed to detect anomalies', { error, metricName });
      return { detected: false, anomalies: [], confidence: 0, recommendations: [] };
    }
  }

  // ====================================================================
  // HELPER METHODS
  // ====================================================================

  private initializeMonitoring(): void {
    if (process.env.NODE_ENV === 'test') {
      logger.info('System monitoring initialized (test mode, timers disabled)');
      return;
    }

    // Start health check monitoring
    this.healthCheckInterval = setInterval(() => {
      if (this.monitoringEnabled) {
        this.performHealthCheck();
      }
    }, 60000); // Every minute

    logger.info('System monitoring initialized');
  }

  private async performHealthCheck(): Promise<void> {
    try {
      // Collect system metrics
      await this.collectSystemMetrics();
      
      // Check for alerts
      await this.evaluateAlertConditions();
      
      // Clean up old data
      await this.cleanupOldData();
    } catch (error) {
      logger.error('Health check failed', { error });
    }
  }

  private async collectSystemMetrics(): Promise<void> {
    try {
      const timestamp = new Date();

      // Simulate collecting various system metrics
      const metrics = [
        {
          metricName: 'cpu_usage',
          metricType: 'gauge' as const,
          component: 'system',
          value: Math.random() * 100, // Mock CPU usage
          unit: 'percentage'
        },
        {
          metricName: 'memory_usage',
          metricType: 'gauge' as const,
          component: 'system',
          value: Math.random() * 100, // Mock memory usage
          unit: 'percentage'
        },
        {
          metricName: 'response_time',
          metricType: 'timer' as const,
          component: 'api',
          value: Math.random() * 1000, // Mock response time
          unit: 'ms'
        }
      ];

      for (const metric of metrics) {
        await prisma.systemMetrics.create({
          data: {
            ...metric,
            timestamp,
            tags: {},
            dimensions: {}
          }
        });
      }
    } catch (error) {
      logger.error('Failed to collect system metrics', { error });
    }
  }

  private async evaluateAlertConditions(): Promise<void> {
    // Check recent metrics against alert thresholds
    const recentMetrics = await prisma.systemMetrics.findMany({
      where: {
        timestamp: { gte: new Date(Date.now() - 5 * 60 * 1000) } // Last 5 minutes
      }
    });

    for (const metric of recentMetrics) {
      await this.checkAlertConditions({
        metricName: metric.metricName,
        metricType: metric.metricType as any,
        component: metric.component,
        value: Number(metric.value),
        unit: metric.unit || undefined,
        timestamp: metric.timestamp
      });
    }
  }

  private async cleanupOldData(): Promise<void> {
    try {
      // Clean up old metrics (older than retention period)
      await prisma.systemMetrics.deleteMany({
        where: {
          timestamp: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } // 90 days
        }
      });

      // Clean up resolved alerts older than 1 year
      await prisma.systemAlerts.deleteMany({
        where: {
          status: 'resolved',
          resolvedAt: { lt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) }
        }
      });
    } catch (error) {
      logger.error('Failed to cleanup old data', { error });
    }
  }

  private async predictCapacityUtilization(): Promise<number> {
    // Simple capacity prediction based on current trends
    // In production, this would use more sophisticated forecasting
    try {
      const recentMetrics = await prisma.systemMetrics.findMany({
        where: {
          metricName: { in: ['cpu_usage', 'memory_usage'] },
          timestamp: { gte: new Date(Date.now() - 60 * 60 * 1000) } // Last hour
        }
      });

      if (recentMetrics.length === 0) return 0;

      const avgUtilization = recentMetrics.reduce((sum, m) => sum + Number(m.value), 0) / recentMetrics.length;
      
      // Simple linear projection (increase by 10% over next 24 hours)
      return Math.min(100, avgUtilization * 1.1);
    } catch (error) {
      logger.error('Failed to predict capacity utilization', { error });
      return 0;
    }
  }

  private async sendAlertNotifications(alertData: any): Promise<void> {
    // Mock notification sending - in production, integrate with notification service
    logger.info('Alert notification sent', {
      alert: alertData.name,
      severity: alertData.severity
    });
  }

  private generateAnomalyRecommendations(anomalies: any[]): string[] {
    const recommendations = [];

    if (anomalies.some(a => a.metric === 'response_time')) {
      recommendations.push('Consider optimizing API endpoints or scaling server resources');
    }

    if (anomalies.some(a => a.metric === 'error_rate')) {
      recommendations.push('Investigate recent code deployments or system changes');
    }

    if (anomalies.some(a => a.metric === 'cpu_usage')) {
      recommendations.push('Monitor for resource-intensive processes or consider scaling');
    }

    if (recommendations.length === 0) {
      recommendations.push('Continue monitoring for patterns and consider investigating root causes');
    }

    return recommendations;
  }

  /**
   * Stop monitoring (cleanup method)
   */
  public stopMonitoring(): void {
    this.monitoringEnabled = false;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    logger.info('System monitoring stopped');
  }
}

export const systemMonitoringService = SystemMonitoringService.getInstance();