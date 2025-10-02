// ====================================================================
// ANALYTICS & MONITORING TYPE DEFINITIONS
// Complete TypeScript interfaces for platform analytics
// ====================================================================

export interface EventData {
  // Event identification
  eventName: string;
  eventCategory: string;
  eventAction: string;
  
  // Event context
  userId?: string;
  sessionId?: string;
  
  // Event metadata
  eventProperties?: Record<string, any>;
  eventValue?: number;
  
  // Technical context
  userAgent?: string;
  ipAddress?: string;
  deviceType?: 'desktop' | 'mobile' | 'tablet';
  browserName?: string;
  operatingSystem?: string;
  
  // Location context
  country?: string;
  state?: string;
  city?: string;
  timezone?: string;
  
  // Referral and attribution
  referrerUrl?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  
  // Page and feature context
  pageUrl?: string;
  featureName?: string;
  componentName?: string;
  
  // Timing and performance
  pageLoadTime?: number;
  serverProcessingTime?: number;
  
  // Experiment and testing
  experimentId?: string;
  experimentVariant?: string;
}

export interface SystemMetricData {
  // Metric identification
  metricName: string;
  metricType: 'gauge' | 'counter' | 'histogram' | 'timer' | 'set';
  component: string;
  
  // Metric values
  value: number;
  unit?: string;
  
  // Aggregation data
  minValue?: number;
  maxValue?: number;
  avgValue?: number;
  sumValue?: number;
  count?: number;
  
  // Dimensions and tags
  tags?: Record<string, any>;
  dimensions?: Record<string, any>;
  
  // Time and granularity
  timestamp?: Date;
  granularity?: 'second' | 'minute' | 'hour' | 'day';
  
  // Alert and threshold data
  threshold?: number;
  alertLevel?: 'info' | 'warning' | 'error' | 'critical';
}

export interface BusinessKPIs {
  // Revenue metrics
  totalRevenue: number;
  platformRevenue: number;
  lawyerEarnings: number;
  revenueGrowthRate: number;
  
  // User metrics
  totalUsers: number;
  newUsers: number;
  activeUsers: number;
  userGrowthRate: number;
  userRetentionRate: number;
  
  // Lawyer metrics
  totalLawyers: number;
  newLawyers: number;
  activeLawyers: number;
  lawyerGrowthRate: number;
  lawyerRetentionRate: number;
  
  // Booking metrics
  totalBookings: number;
  bookingConversionRate: number;
  averageBookingValue: number;
  bookingCancellationRate: number;
  
  // Quality metrics
  averageRating: number;
  customerSatisfactionScore: number;
  
  // Financial health
  customerAcquisitionCost: number;
  customerLifetimeValue: number;
  monthlyRecurringRevenue: number;
  churnRate: number;
}

export interface UserBehaviorAnalysis {
  userId: string;
  sessionMetrics: SessionMetrics;
  engagementScore: number;
  behaviorPattern: BehaviorPattern;
  conversionTriggers: string[];
  churnRiskScore: number;
  lifetimeValue: number;
  personalizationProfile: PersonalizationProfile;
}

export interface SessionMetrics {
  sessionDuration: number;
  pageViews: number;
  bounceRate: number;
  deviceType: string;
  trafficSource: string;
  conversionEvents: number;
}

export interface BehaviorPattern {
  primaryActions: string[];
  featureUsage: Record<string, number>;
  preferredTime: string;
  interactionFrequency: 'low' | 'medium' | 'high';
  navigationPattern: string[];
}

export interface PersonalizationProfile {
  preferences: Record<string, any>;
  interests: string[];
  skillLevel: 'beginner' | 'intermediate' | 'advanced';
  goals: string[];
  segments: string[];
}

export interface SystemHealth {
  overallScore: number;
  components: ComponentHealth[];
  activeAlerts: AlertSummary[];
  performanceTrends: PerformanceTrend[];
  capacityMetrics: CapacityMetrics;
}

export interface ComponentHealth {
  component: string;
  status: 'healthy' | 'warning' | 'error' | 'critical';
  responseTime: number;
  errorRate: number;
  availability: number;
  lastChecked: Date;
}

export interface AlertSummary {
  id: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  component: string;
  triggeredAt: Date;
  isResolved: boolean;
}

export interface PerformanceTrend {
  metric: string;
  current: number;
  trend: 'up' | 'down' | 'stable';
  changePercent: number;
  period: string;
}

export interface CapacityMetrics {
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  networkUsage: number;
  databaseConnections: number;
  predictedCapacity: number;
}

export interface Dashboard {
  type: 'executive' | 'operational' | 'lawyer' | 'custom';
  title: string;
  lastUpdated: Date;
  widgets: DashboardWidget[];
  filters: DashboardFilter[];
  refreshInterval: number;
}

export interface DashboardWidget {
  id: string;
  type: 'chart' | 'metric' | 'table' | 'alert' | 'map';
  title: string;
  data: any;
  config: WidgetConfig;
  position: { x: number; y: number; width: number; height: number };
}

export interface WidgetConfig {
  chartType?: 'line' | 'bar' | 'pie' | 'area' | 'gauge';
  timeRange?: TimeRange;
  metrics?: string[];
  dimensions?: string[];
  aggregation?: 'sum' | 'avg' | 'min' | 'max' | 'count';
  colors?: string[];
}

export interface DashboardFilter {
  key: string;
  label: string;
  type: 'select' | 'date' | 'text' | 'number';
  options?: FilterOption[];
  value?: any;
}

export interface FilterOption {
  label: string;
  value: any;
}

export interface TimeRange {
  start: Date;
  end: Date;
  period: 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';
}

export interface AnalyticsFilters {
  dateRange?: TimeRange;
  userSegment?: string[];
  location?: LocationFilter;
  practiceArea?: string[];
  deviceType?: string[];
  trafficSource?: string[];
  customFilters?: Record<string, any>;
}

export interface LocationFilter {
  countries?: string[];
  states?: string[];
  cities?: string[];
}

export interface UserJourneyAnalysis {
  journeyType: string;
  totalJourneys: number;
  completionRate: number;
  averageDuration: number;
  dropOffPoints: DropOffPoint[];
  conversionFunnel: FunnelStep[];
  optimizationOpportunities: OptimizationOpportunity[];
}

export interface DropOffPoint {
  step: string;
  dropOffRate: number;
  reasonsAnalysis: string[];
  impactScore: number;
}

export interface FunnelStep {
  name: string;
  users: number;
  conversionRate: number;
  averageTime: number;
}

export interface OptimizationOpportunity {
  area: string;
  impact: 'low' | 'medium' | 'high';
  effort: 'low' | 'medium' | 'high';
  description: string;
  expectedImprovement: number;
}

export interface AnomalyDetection {
  detected: boolean;
  anomalies: Anomaly[];
  confidence: number;
  recommendations: string[];
}

export interface Anomaly {
  metric: string;
  timestamp: Date;
  expectedValue: number;
  actualValue: number;
  severity: 'low' | 'medium' | 'high';
  description: string;
}

export interface ExperimentConfig {
  experimentId: string;
  name: string;
  hypothesis: string;
  type: 'ab_test' | 'multivariate' | 'feature_flag';
  variants: ExperimentVariant[];
  targetMetric: string;
  sampleSize: number;
  duration: number;
  targetingCriteria: TargetingCriteria;
}

export interface ExperimentVariant {
  name: string;
  description: string;
  trafficAllocation: number;
  configuration: Record<string, any>;
}

export interface TargetingCriteria {
  userSegments?: string[];
  locations?: LocationFilter;
  deviceTypes?: string[];
  newUsersOnly?: boolean;
  customCriteria?: Record<string, any>;
}

export interface ExperimentAnalysis {
  experimentId: string;
  status: 'running' | 'completed' | 'paused';
  participants: number;
  duration: number;
  results: ExperimentResults;
  statisticalSignificance: number;
  recommendation: ExperimentRecommendation;
}

export interface ExperimentResults {
  variants: VariantResult[];
  winningVariant?: string;
  lift: number;
  pValue: number;
  confidenceInterval: [number, number];
}

export interface VariantResult {
  name: string;
  participants: number;
  conversionRate: number;
  averageValue: number;
  confidence: number;
}

export interface ExperimentRecommendation {
  action: 'continue' | 'conclude' | 'pause' | 'stop';
  reasoning: string;
  expectedImpact: number;
  risks: string[];
}

export interface BusinessInsights {
  keyTrends: Trend[];
  opportunities: Opportunity[];
  risks: Risk[];
  recommendations: Recommendation[];
  marketPosition: MarketPosition;
  competitiveAnalysis: CompetitiveAnalysis;
}

export interface Trend {
  name: string;
  direction: 'up' | 'down' | 'stable';
  magnitude: number;
  timeframe: string;
  significance: 'low' | 'medium' | 'high';
  description: string;
}

export interface Opportunity {
  name: string;
  category: string;
  impact: 'low' | 'medium' | 'high';
  effort: 'low' | 'medium' | 'high';
  timeline: string;
  description: string;
  estimatedValue: number;
}

export interface Risk {
  name: string;
  category: string;
  probability: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  timeline: string;
  description: string;
  mitigationStrategies: string[];
}

export interface Recommendation {
  title: string;
  category: string;
  status: 'low' | 'medium' | 'high' | 'critical';
  effort: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  description: string;
  actionItems: string[];
  expectedOutcome: string;
}

export interface MarketPosition {
  marketShare: number;
  competitiveRank: number;
  growthRate: number;
  marketTrends: string[];
  differentiators: string[];
}

export interface CompetitiveAnalysis {
  competitors: Competitor[];
  benchmarks: Benchmark[];
  gaps: string[];
  advantages: string[];
}

export interface Competitor {
  name: string;
  marketShare: number;
  strengths: string[];
  weaknesses: string[];
  positioning: string;
}

export interface Benchmark {
  metric: string;
  ourValue: number;
  industryAverage: number;
  bestInClass: number;
  performance: 'below' | 'at' | 'above';
}

export interface DemandForecast {
  timeframe: string;
  predictions: PredictionPoint[];
  confidence: number;
  methodology: string;
  assumptions: string[];
  factors: ForecastFactor[];
}

export interface PredictionPoint {
  date: Date;
  value: number;
  upperBound: number;
  lowerBound: number;
  confidence: number;
}

export interface ForecastFactor {
  name: string;
  impact: 'positive' | 'negative' | 'neutral';
  weight: number;
  description: string;
}

export interface ChurnPrediction {
  userId: string;
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high';
  predictedChurnDate?: Date;
  keyFactors: ChurnFactor[];
  interventionRecommendations: InterventionRecommendation[];
}

export interface ChurnFactor {
  factor: string;
  impact: number;
  category: 'engagement' | 'satisfaction' | 'value' | 'usage' | 'support';
  description: string;
}

export interface InterventionRecommendation {
  type: 'email' | 'discount' | 'support' | 'feature' | 'content';
  status: 'low' | 'medium' | 'high';
  timing: 'immediate' | 'within_week' | 'within_month';
  description: string;
  expectedImpact: number;
}

export interface PricingOptimization {
  currentPricing: PricingModel;
  recommendations: PricingRecommendation[];
  elasticityAnalysis: ElasticityAnalysis;
  competitiveLandscape: CompetitivePricing;
  revenueProjections: RevenueProjection[];
}

export interface PricingModel {
  tiers: PricingTier[];
  discounts: DiscountModel[];
}

export interface PricingTier {
  name: string;
  price: number;
  features: string[];
  targetSegment: string;
  adoption: number;
}

export interface DiscountModel {
  type: string;
  percentage: number;
  conditions: string[];
  usage: number;
}

export interface PricingRecommendation {
  type: 'increase' | 'decrease' | 'restructure' | 'new_tier';
  target: string;
  change: number;
  reasoning: string;
  expectedImpact: number;
  risks: string[];
}

export interface ElasticityAnalysis {
  priceElasticity: number;
  demandSensitivity: 'low' | 'medium' | 'high';
  optimalPricePoint: number;
  revenueMaximizingPrice: number;
}

export interface CompetitivePricing {
  competitors: CompetitorPricing[];
  positioningAnalysis: string;
  pricingGaps: string[];
}

export interface CompetitorPricing {
  name: string;
  pricing: PricingTier[];
  advantages: string[];
  disadvantages: string[];
}

export interface RevenueProjection {
  scenario: string;
  timeframe: string;
  projectedRevenue: number;
  confidence: number;
  assumptions: string[];
}

// API Request/Response Types
export interface AnalyticsRequest {
  timeRange: TimeRange;
  filters?: AnalyticsFilters;
  metrics?: string[];
  granularity?: 'hour' | 'day' | 'week' | 'month';
}

export interface AnalyticsResponse<T = any> {
  success: boolean;
  data: T;
  metadata: {
    totalRecords: number;
    timeRange: TimeRange;
    generatedAt: Date;
    cacheDuration: number;
  };
  errors?: string[];
}

export interface EventTrackingRequest {
  events: EventData[];
  batchId?: string;
  source?: string;
}

export interface CustomReportRequest {
  name: string;
  description?: string;
  metrics: string[];
  dimensions: string[];
  filters: AnalyticsFilters;
  timeRange: TimeRange;
  format: 'json' | 'csv' | 'pdf' | 'excel';
  schedule?: ScheduleConfig;
}

export interface ScheduleConfig {
  frequency: 'daily' | 'weekly' | 'monthly';
  time: string;
  timezone: string;
  recipients: string[];
}

export interface AlertConfiguration {
  name: string;
  description: string;
  metric: string;
  condition: 'greater_than' | 'less_than' | 'equals' | 'not_equals';
  threshold: number;
  severity: 'info' | 'warning' | 'error' | 'critical';
  enabled: boolean;
  notifications: NotificationConfig[];
}

export interface NotificationConfig {
  channel: 'email' | 'slack' | 'webhook' | 'sms';
  recipients: string[];
  escalation?: EscalationConfig;
}

export interface EscalationConfig {
  timeMinutes: number;
  recipients: string[];
  maxEscalations: number;
}

// Utility Types
export type Period = 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'last_quarter' | 'last_year' | 'custom';

export type MetricUnit = 'count' | 'percentage' | 'currency' | 'time' | 'bytes' | 'rate';

export type AggregationType = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'median' | 'percentile';

export type SegmentationType = 'behavioral' | 'demographic' | 'geographic' | 'value' | 'lifecycle' | 'custom';

// Error Types
export class AnalyticsError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AnalyticsError';
  }
}

export class MetricsCollectionError extends AnalyticsError {
  constructor(message: string, details?: any) {
    super(message, 'METRICS_COLLECTION_ERROR', details);
  }
}

export class DashboardGenerationError extends AnalyticsError {
  constructor(message: string, details?: any) {
    super(message, 'DASHBOARD_GENERATION_ERROR', details);
  }
}

export class AlertProcessingError extends AnalyticsError {
  constructor(message: string, details?: any) {
    super(message, 'ALERT_PROCESSING_ERROR', details);
  }
}