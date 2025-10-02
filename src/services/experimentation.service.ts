// ====================================================================
// EXPERIMENTATION SERVICE
// A/B testing, feature flags, and experiment management
// ====================================================================

import { PrismaClient } from '@prisma/client';
import {
  ExperimentConfig,
  ExperimentAnalysis,
  ExperimentResults,
  VariantResult,
  ExperimentRecommendation,
  AnalyticsError
} from '../types/analytics.types';

const prisma = new PrismaClient();

// Simple logger
const logger = {
  info: (message: string, meta?: any) => console.log(`[INFO] ${message}`, meta || ''),
  error: (message: string, meta?: any) => console.error(`[ERROR] ${message}`, meta || ''),
  warn: (message: string, meta?: any) => console.warn(`[WARN] ${message}`, meta || '')
};

export class ExperimentationService {
  private static instance: ExperimentationService;
  private activeExperiments = new Map<string, ExperimentConfig>();

  private constructor() {
    this.initializeExperiments();
  }

  public static getInstance(): ExperimentationService {
    if (!ExperimentationService.instance) {
      ExperimentationService.instance = new ExperimentationService();
    }
    return ExperimentationService.instance;
  }

  // ====================================================================
  // EXPERIMENT MANAGEMENT
  // ====================================================================

  /**
   * Create a new experiment
   */
  async createExperiment(config: ExperimentConfig): Promise<string> {
    try {
      // Validate experiment configuration
      this.validateExperimentConfig(config);

      // Check if experiment already exists
      const existingExperiment = await prisma.experimentResults.findUnique({
        where: { experimentId: config.experimentId }
      });

      if (existingExperiment) {
        throw new Error(`Experiment with ID ${config.experimentId} already exists`);
      }

      // Create experiment record
      await prisma.experimentResults.create({
        data: {
          experimentId: config.experimentId,
          experimentName: config.name,
          experimentType: config.type,
          hypothesis: config.hypothesis || 'No hypothesis provided',
          startDate: new Date(),
          targetSampleSize: config.sampleSize,
          variants: config.variants as any,
          variantResults: {},
          primaryMetric: config.targetMetric
        }
      });

      // Store in memory for quick access
      this.activeExperiments.set(config.experimentId, config);

      logger.info('Experiment created successfully', {
        experimentId: config.experimentId,
        name: config.name,
        variants: config.variants.length
      });

      return config.experimentId;
    } catch (error) {
      logger.error('Failed to create experiment', { error, config });
      throw new AnalyticsError('Failed to create experiment', 'EXPERIMENT_CREATE_ERROR', { error });
    }
  }

  /**
   * Get experiment assignment for user
   */
  async getExperimentAssignment(experimentId: string, userId: string): Promise<string | null> {
    try {
      const experiment = this.activeExperiments.get(experimentId);
      if (!experiment) {
        return null;
      }

      // Check if user meets targeting criteria
      if (!await this.userMeetsTargeting(userId, experiment.targetingCriteria)) {
        return null;
      }

      // Determine variant assignment using consistent hashing
      const variant = this.assignUserToVariant(userId, experiment);
      
      // Track assignment event
      await this.trackExperimentEvent(experimentId, userId, variant, 'assigned');

      return variant;
    } catch (error) {
      logger.error('Failed to get experiment assignment', { error, experimentId, userId });
      return null;
    }
  }

  /**
   * Record experiment event (conversion, interaction, etc.)
   */
  async recordExperimentEvent(
    experimentId: string,
    userId: string,
    eventType: string,
    value?: number
  ): Promise<void> {
    try {
      const experiment = this.activeExperiments.get(experimentId);
      if (!experiment) {
        logger.warn('Experiment not found for event recording', { experimentId });
        return;
      }

      // Get user's variant assignment
      const variant = await this.getUserVariantAssignment(experimentId, userId);
      if (!variant) {
        return;
      }

      // Track the event
      await this.trackExperimentEvent(experimentId, userId, variant, eventType, value);

      // Update experiment results if it's a conversion event
      if (eventType === 'conversion' || eventType === experiment.targetMetric) {
        await this.updateExperimentResults(experimentId, variant, eventType, value);
      }
    } catch (error) {
      logger.error('Failed to record experiment event', { error, experimentId, eventType });
    }
  }

  /**
   * Analyze experiment results
   */
  async analyzeExperiment(experimentId: string): Promise<ExperimentAnalysis> {
    try {
      const experiment = await prisma.experimentResults.findUnique({
        where: { experimentId }
      });

      if (!experiment) {
        throw new Error(`Experiment ${experimentId} not found`);
      }

      // Get experiment events
      const events = await prisma.eventTracking.findMany({
        where: {
          experimentId,
          eventTimestamp: { gte: experiment.startDate }
        }
      });

      // Calculate results for each variant
      const variantResults = await this.calculateVariantResults(experimentId, events);
      
      // Perform statistical analysis
      const statisticalAnalysis = this.performStatisticalAnalysis(variantResults);
      
      // Generate recommendation
      const recommendation = this.generateExperimentRecommendation(
        experiment,
        variantResults,
        statisticalAnalysis
      );

      // Update experiment record with results
      await prisma.experimentResults.update({
        where: { experimentId },
        data: {
          variantResults: variantResults as any,
          totalParticipants: variantResults.reduce((sum, v) => sum + v.participants, 0),
          conversionRate: this.calculateOverallConversionRate(variantResults),
          statisticalSignificance: statisticalAnalysis.significance,
          pValue: statisticalAnalysis.pValue,
          winningVariant: statisticalAnalysis.winningVariant,
          liftPercentage: statisticalAnalysis.lift
        }
      });

      return {
        experimentId,
        status: experiment.status as any,
        participants: variantResults.reduce((sum, v) => sum + v.participants, 0),
        duration: Math.floor((Date.now() - experiment.startDate.getTime()) / (1000 * 60 * 60 * 24)),
        results: {
          variants: variantResults,
          winningVariant: statisticalAnalysis.winningVariant,
          lift: statisticalAnalysis.lift,
          pValue: statisticalAnalysis.pValue,
          confidenceInterval: statisticalAnalysis.confidenceInterval
        },
        statisticalSignificance: statisticalAnalysis.significance,
        recommendation
      };
    } catch (error) {
      logger.error('Failed to analyze experiment', { error, experimentId });
      throw new AnalyticsError('Failed to analyze experiment', 'EXPERIMENT_ANALYSIS_ERROR', { error });
    }
  }

  /**
   * Stop experiment
   */
  async stopExperiment(experimentId: string, reason?: string): Promise<void> {
    try {
      await prisma.experimentResults.update({
        where: { experimentId },
        data: {
          status: 'completed',
          endDate: new Date(),
          conclusion: reason || 'Experiment stopped manually'
        }
      });

      // Remove from active experiments
      this.activeExperiments.delete(experimentId);

      logger.info('Experiment stopped', { experimentId, reason });
    } catch (error) {
      logger.error('Failed to stop experiment', { error, experimentId });
      throw new AnalyticsError('Failed to stop experiment', 'EXPERIMENT_STOP_ERROR', { error });
    }
  }

  // ====================================================================
  // STATISTICAL ANALYSIS
  // ====================================================================

  /**
   * Perform statistical significance testing
   */
  private performStatisticalAnalysis(variantResults: VariantResult[]): {
    significance: number;
    pValue: number;
    winningVariant?: string;
    lift: number;
    confidenceInterval: [number, number];
  } {
    if (variantResults.length < 2) {
      return {
        significance: 0,
        pValue: 1,
        lift: 0,
        confidenceInterval: [0, 0]
      };
    }

    // Find control and treatment groups
    const control = variantResults.find(v => v.name === 'control') || variantResults[0];
    const treatment = variantResults.find(v => v.name !== 'control') || variantResults[1];

    // Calculate z-score for proportions test
    const p1 = control.conversionRate / 100;
    const p2 = treatment.conversionRate / 100;
    const n1 = control.participants;
    const n2 = treatment.participants;

    // Pooled proportion
    const pPooled = ((p1 * n1) + (p2 * n2)) / (n1 + n2);
    
    // Standard error
    const se = Math.sqrt(pPooled * (1 - pPooled) * (1/n1 + 1/n2));
    
    // Z-score
    const zScore = (p2 - p1) / se;
    
    // Two-tailed p-value
    const pValue = 2 * (1 - this.normalCDF(Math.abs(zScore)));
    
    // Statistical significance (confidence level)
    const significance = (1 - pValue) * 100;
    
    // Lift calculation
    const lift = p1 > 0 ? ((p2 - p1) / p1) * 100 : 0;
    
    // Confidence interval for lift (approximate)
    const confidenceInterval: [number, number] = [
      lift - (1.96 * Math.sqrt(lift)),
      lift + (1.96 * Math.sqrt(lift))
    ];

    // Determine winning variant
    const winningVariant = p2 > p1 ? treatment.name : control.name;

    return {
      significance,
      pValue,
      winningVariant: significance > 95 ? winningVariant : undefined,
      lift,
      confidenceInterval
    };
  }

  /**
   * Normal cumulative distribution function (approximation)
   */
  private normalCDF(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - prob : prob;
  }

  // ====================================================================
  // HELPER METHODS
  // ====================================================================

  private validateExperimentConfig(config: ExperimentConfig): void {
    if (!config.experimentId) {
      throw new Error('Experiment ID is required');
    }
    if (!config.name) {
      throw new Error('Experiment name is required');
    }
    if (!config.variants || config.variants.length < 2) {
      throw new Error('At least 2 variants are required');
    }
    
    // Validate traffic allocation adds up to 100%
    const totalTraffic = config.variants.reduce((sum, v) => sum + v.trafficAllocation, 0);
    if (Math.abs(totalTraffic - 100) > 0.01) {
      throw new Error('Variant traffic allocation must sum to 100%');
    }
  }

  private async userMeetsTargeting(userId: string, criteria: any): Promise<boolean> {
    // Simplified targeting logic - in production, this would be more sophisticated
    if (!criteria) return true;
    
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return false;

      // Check user segments
      if (criteria.userSegments && criteria.userSegments.length > 0) {
        // Mock segment check - in production, derive from user data
        return true;
      }

      // Check if new users only
      if (criteria.newUsersOnly) {
        const daysSinceCreation = (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24);
        return daysSinceCreation <= 7; // New user = created within 7 days
      }

      return true;
    } catch (error) {
      logger.error('Error checking user targeting', { error, userId });
      return false;
    }
  }

  private assignUserToVariant(userId: string, experiment: ExperimentConfig): string {
    // Consistent hash-based assignment
    const hash = this.hashString(userId + experiment.experimentId);
    const bucket = hash % 100;
    
    let cumulativeTraffic = 0;
    for (const variant of experiment.variants) {
      cumulativeTraffic += variant.trafficAllocation;
      if (bucket < cumulativeTraffic) {
        return variant.name;
      }
    }
    
    // Fallback to first variant
    return experiment.variants[0].name;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  private async trackExperimentEvent(
    experimentId: string,
    userId: string,
    variant: string,
    eventType: string,
    value?: number
  ): Promise<void> {
    await prisma.eventTracking.create({
      data: {
        eventName: `experiment_${eventType}`,
        eventCategory: 'experiment',
        eventAction: eventType,
        userId,
        experimentId,
        experimentVariant: variant,
        eventValue: value,
        eventProperties: {
          experimentId,
          variant,
          eventType
        }
      }
    });
  }

  private async getUserVariantAssignment(experimentId: string, userId: string): Promise<string | null> {
    const assignmentEvent = await prisma.eventTracking.findFirst({
      where: {
        userId,
        experimentId,
        eventAction: 'assigned'
      },
      orderBy: { eventTimestamp: 'desc' }
    });

    return assignmentEvent?.experimentVariant || null;
  }

  private async updateExperimentResults(
    experimentId: string,
    variant: string,
    eventType: string,
    value?: number
  ): Promise<void> {
    // This would update real-time experiment metrics
    // For now, we'll just log the event
    logger.info('Experiment conversion recorded', {
      experimentId,
      variant,
      eventType,
      value
    });
  }

  private async calculateVariantResults(experimentId: string, events: any[]): Promise<VariantResult[]> {
    const variantMap = new Map<string, {
      participants: Set<string>;
      conversions: number;
      totalValue: number;
    }>();

    // Process events to calculate variant metrics
    events.forEach(event => {
      if (!event.experimentVariant) return;

      if (!variantMap.has(event.experimentVariant)) {
        variantMap.set(event.experimentVariant, {
          participants: new Set(),
          conversions: 0,
          totalValue: 0
        });
      }

      const variantData = variantMap.get(event.experimentVariant)!;
      
      if (event.userId) {
        variantData.participants.add(event.userId);
      }

      if (event.eventAction === 'conversion' || event.eventName.includes('conversion')) {
        variantData.conversions++;
        variantData.totalValue += Number(event.eventValue) || 0;
      }
    });

    // Convert to VariantResult array
    const results: VariantResult[] = [];
    for (const [variantName, data] of variantMap) {
      const participants = data.participants.size;
      const conversionRate = participants > 0 ? (data.conversions / participants) * 100 : 0;
      const averageValue = data.conversions > 0 ? data.totalValue / data.conversions : 0;

      results.push({
        name: variantName,
        participants,
        conversionRate,
        averageValue,
        confidence: participants > 100 ? 95 : 80 // Mock confidence based on sample size
      });
    }

    return results;
  }

  private calculateOverallConversionRate(variantResults: VariantResult[]): number {
    const totalParticipants = variantResults.reduce((sum, v) => sum + v.participants, 0);
    const totalConversions = variantResults.reduce((sum, v) => sum + (v.participants * v.conversionRate / 100), 0);
    
    return totalParticipants > 0 ? (totalConversions / totalParticipants) * 100 : 0;
  }

  private generateExperimentRecommendation(
    experiment: any,
    variantResults: VariantResult[],
    statisticalAnalysis: any
  ): ExperimentRecommendation {
    const { significance, lift, winningVariant } = statisticalAnalysis;
    const totalParticipants = variantResults.reduce((sum, v) => sum + v.participants, 0);

    if (significance > 95 && Math.abs(lift) > 5) {
      return {
        action: 'conclude',
        reasoning: `Experiment has reached statistical significance (${significance.toFixed(1)}%) with a ${lift > 0 ? 'positive' : 'negative'} lift of ${Math.abs(lift).toFixed(1)}%`,
        expectedImpact: Math.abs(lift),
        risks: lift < 0 ? ['Implementing losing variant will reduce performance'] : []
      };
    } else if (totalParticipants < experiment.targetSampleSize) {
      return {
        action: 'continue',
        reasoning: `Experiment needs more data to reach statistical significance. Current sample size: ${totalParticipants}, target: ${experiment.targetSampleSize}`,
        expectedImpact: 0,
        risks: ['Early stopping may lead to incorrect conclusions']
      };
    } else if (significance < 80) {
      return {
        action: 'pause',
        reasoning: 'Experiment is not showing significant results after reaching target sample size',
        expectedImpact: 0,
        risks: ['Continuing may waste resources without actionable insights']
      };
    } else {
      return {
        action: 'continue',
        reasoning: 'Experiment is trending towards significance but needs more time',
        expectedImpact: Math.abs(lift),
        risks: ['Results may not reach statistical significance']
      };
    }
  }

  private async initializeExperiments(): Promise<void> {
    try {
      // Load active experiments from database
      const activeExperiments = await prisma.experimentResults.findMany({
        where: { status: 'running' }
      });

      // Convert to ExperimentConfig format and store in memory
      for (const exp of activeExperiments) {
        const config: ExperimentConfig = {
          experimentId: exp.experimentId,
          name: exp.experimentName,
          hypothesis: exp.hypothesis,
          type: exp.experimentType as any,
          variants: exp.variants as any,
          targetMetric: exp.primaryMetric,
          sampleSize: exp.targetSampleSize || 1000,
          duration: 30, // Default 30 days
          targetingCriteria: {} // Default no targeting
        };

        this.activeExperiments.set(exp.experimentId, config);
      }

      logger.info(`Loaded ${activeExperiments.length} active experiments`);
    } catch (error) {
      logger.error('Failed to initialize experiments', { error });
    }
  }
}

export const experimentationService = ExperimentationService.getInstance();