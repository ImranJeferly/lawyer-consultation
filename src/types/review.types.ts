// Types and interfaces for the comprehensive review system

export enum ReviewStatus {
  PENDING = 'pending',
  PUBLISHED = 'published',
  REJECTED = 'rejected',
  DISPUTED = 'disputed',
  HIDDEN = 'hidden'
}

export enum ModerationStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  FLAGGED = 'flagged'
}

export enum ConsultationType {
  PHONE = 'phone',
  VIDEO = 'video',
  IN_PERSON = 'in_person'
}

export enum FlagReason {
  FAKE_REVIEW = 'fake_review',
  INAPPROPRIATE_CONTENT = 'INAPPROPRIATE',
  SPAM = 'spam',
  OFF_TOPIC = 'off_topic',
  PERSONAL_ATTACK = 'HARASSMENT',
  DEFAMATORY = 'defamatory',
  VIOLATES_POLICY = 'violates_policy'
}

export enum DisputeReason {
  FACTUALLY_INCORRECT = 'factually_incorrect',
  DEFAMATORY = 'defamatory',
  FAKE_REVIEW = 'fake_review',
  VIOLATES_POLICY = 'violates_policy',
  PERSONAL_ATTACK = 'HARASSMENT'
}

export enum DisputeStatus {
  SUBMITTED = 'submitted',
  UNDER_REVIEW = 'under_review',
  RESOLVED = 'resolved',
  REJECTED = 'rejected',
  APPEALED = 'appealed'
}

export enum ModerationAction {
  APPROVE = 'approve',
  REJECT = 'reject',
  FLAG = 'flag',
  REQUIRE_EDIT = 'require_edit'
}

export enum DisputeResolution {
  REVIEW_REMOVED = 'review_removed',
  REVIEW_MODIFIED = 'review_modified',
  DISPUTE_REJECTED = 'dispute_rejected',
  UNDER_INVESTIGATION = 'under_investigation',
  WITHDRAWN_BY_LAWYER = 'withdrawn_by_lawyer'
}

export enum ResponseType {
  STANDARD = 'standard',
  APOLOGY = 'apology',
  CLARIFICATION = 'clarification',
  DISPUTE = 'dispute'
}

// Core Review Interface
export interface Review {
  id: string;
  appointmentId: string;
  clientId: string;
  lawyerId: string;
  
  // Multi-dimensional ratings (1-5)
  overallRating: number;
  communicationRating?: number;
  expertiseRating?: number;
  responsivenessRating?: number;
  valueRating?: number;
  professionalismRating?: number;
  
  // Review content
  reviewTitle?: string;
  reviewText?: string;
  reviewLength: number;
  
  // Context
  consultationType?: ConsultationType;
  caseCategory?: string;
  recommendsLawyer?: boolean;
  
  // Verification and authenticity
  isVerified: boolean;
  verificationMethod?: string;
  verificationScore: number;
  
  // Status
  status: ReviewStatus;
  moderationStatus: ModerationStatus;
  
  // Engagement
  helpfulVotes: number;
  unhelpfulVotes: number;
  totalVotes: number;
  viewCount: number;
  
  // Quality indicators
  isHighQuality: boolean;
  sentimentScore: number;
  contentQualityScore: number;
  
  // Version control
  editCount: number;
  lastEditedAt?: Date;
  originalContent?: string;
  
  // Moderation
  moderatedBy?: string;
  moderatedAt?: Date;
  moderationNotes?: string;
  autoModerationFlags: Record<string, any>;
  
  // Publishing
  publishedAt?: Date;
  isPublic: boolean;
  isPromoted: boolean;
  
  // Legal
  isPinned: boolean;
  isDisputed: boolean;
  disputeResolution?: string;
  
  // Metadata
  reviewMetadata: Record<string, any>;
  userAgent?: string;
  ipAddress?: string;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

// Review creation data
export interface CreateReviewData {
  appointmentId: string;
  overallRating: number;
  communicationRating?: number;
  expertiseRating?: number;
  responsivenessRating?: number;
  valueRating?: number;
  professionalismRating?: number;
  reviewTitle?: string;
  reviewText?: string;
  consultationType?: ConsultationType;
  caseCategory?: string;
  recommendsLawyer?: boolean;
}

// Review update data
export interface UpdateReviewData {
  overallRating?: number;
  communicationRating?: number;
  expertiseRating?: number;
  responsivenessRating?: number;
  valueRating?: number;
  professionalismRating?: number;
  reviewTitle?: string;
  reviewText?: string;
  recommendsLawyer?: boolean;
}

// Review Response Interface
export interface ReviewResponse {
  id: string;
  reviewId: string;
  lawyerId: string;
  
  // Content
  responseText: string;
  responseLength: number;
  
  // Type and analysis
  responseType: ResponseType;
  responseTone?: string;
  
  // Status
  status: ReviewStatus;
  moderationStatus: ModerationStatus;
  
  // Moderation
  moderatedBy?: string;
  moderatedAt?: Date;
  moderationNotes?: string;
  
  // Quality
  isHelpful: boolean;
  helpfulVotes: number;
  responseQualityScore: number;
  
  // Publishing
  publishedAt?: Date;
  isPublic: boolean;
  
  // Version control
  editCount: number;
  lastEditedAt?: Date;
  originalResponse?: string;
  
  // Analytics
  viewCount: number;
  
  createdAt: Date;
  updatedAt: Date;
}

// Review Flag Interface
export interface ReviewFlag {
  id: string;
  reviewId: string;
  flaggerId: string;
  
  flagReason: FlagReason;
  flagDescription?: string;
  evidenceUrls: string[];
  additionalContext?: string;
  
  status: string;
  investigatedBy?: string;
  investigatedAt?: Date;
  investigationNotes?: string;
  resolution?: string;
  
  isValidFlag?: boolean;
  flagQualityScore: number;
  
  flaggerNotified: boolean;
  reviewAuthorNotified: boolean;
  
  createdAt: Date;
  updatedAt: Date;
}

// Review Helpfulness Interface
export interface ReviewHelpfulness {
  id: string;
  reviewId: string;
  userId: string;
  
  isHelpful: boolean;
  voteWeight: number;
  voterType?: string;
  hasBookedLawyer: boolean;
  
  userAgent?: string;
  ipAddress?: string;
  
  createdAt: Date;
}

// Review Dispute Interface
export interface ReviewDispute {
  id: string;
  reviewId: string;
  lawyerId: string;
  
  disputeReason: DisputeReason;
  disputeDescription: string;
  evidenceDocuments: string[];
  witnessStatements?: string;
  additionalEvidence: Record<string, any>;
  
  status: DisputeStatus;
  assignedInvestigator?: string;
  investigationStarted?: Date;
  investigationCompleted?: Date;
  investigationNotes?: string;
  
  resolution?: string;
  resolutionReason?: string;
  resolutionNotes?: string;
  resolvedAt?: Date;
  
  isAppealed: boolean;
  appealReason?: string;
  appealedAt?: Date;
  appealResolution?: string;
  
  reviewModified: boolean;
  reviewRemoved: boolean;
  compensationOffered: boolean;
  
  responseDeadline?: Date;
  resolutionDeadline?: Date;
  isOverdue: boolean;
  
  createdAt: Date;
  updatedAt: Date;
}

// Review Analytics Interface
export interface ReviewAnalytics {
  id: string;
  date: Date;
  lawyerId: string;
  
  // Volume metrics
  totalReviews: number;
  newReviews: number;
  verifiedReviews: number;
  
  // Rating metrics
  averageOverallRating: number;
  averageCommunicationRating: number;
  averageExpertiseRating: number;
  averageResponsivenessRating: number;
  averageValueRating: number;
  averageProfessionalismRating: number;
  
  // Distribution
  rating5Count: number;
  rating4Count: number;
  rating3Count: number;
  rating2Count: number;
  rating1Count: number;
  
  // Engagement
  totalHelpfulVotes: number;
  totalViewCount: number;
  averageReviewLength: number;
  
  // Quality
  highQualityReviewCount: number;
  averageSentimentScore: number;
  averageContentQualityScore: number;
  
  // Response metrics
  reviewsWithResponses: number;
  averageResponseTime: number;
  responseRate: number;
  
  // Moderation
  flaggedReviews: number;
  removedReviews: number;
  disputedReviews: number;
  
  // Competitive
  rankInCategory?: number;
  percentileRating?: number;
  
  createdAt: Date;
}

// Validation Result Interface
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// Fraud Detection Interface
export interface FraudAnalysis {
  riskScore: number; // 0-100
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  flags: string[];
  recommendations: string[];
  details: {
    contentAnalysis: ContentAnalysisResult;
    patternAnalysis: PatternAnalysisResult;
    userAnalysis: UserAnalysisResult;
    appointmentAnalysis: AppointmentAnalysisResult;
  };
}

export interface ContentAnalysisResult {
  duplicateScore: number;
  sentimentConsistency: number;
  writingStyleAnalysis: Record<string, any>;
  languageQuality: number;
  specificityScore: number;
}

export interface PatternAnalysisResult {
  timingPatterns: string[];
  ratingPatterns: string[];
  contentPatterns: string[];
  behaviorPatterns: string[];
}

export interface UserAnalysisResult {
  accountAge: number;
  reviewHistory: number;
  credibilityScore: number;
  verificationLevel: string;
  suspiciousActivity: string[];
}

export interface AppointmentAnalysisResult {
  appointmentVerified: boolean;
  paymentVerified: boolean;
  consultationCompleted: boolean;
  appointmentAuthenticity: number;
}

// Review Statistics Interface
export interface ReviewStatistics {
  totalReviews: number;
  averageRating: number;
  ratingDistribution: {
    5: number;
    4: number;
    3: number;
    2: number;
    1: number;
  };
  verifiedReviewPercentage: number;
  recommendationPercentage: number;
  responseRate: number;
  averageResponseTime: number; // in hours
  sentimentBreakdown: {
    positive: number;
    neutral: number;
    negative: number;
  };
  topStrengths: string[];
  topWeaknesses: string[];
}

// Detailed Rating Stats Interface
export interface DetailedRatingStats {
  overall: RatingMetric;
  communication: RatingMetric;
  expertise: RatingMetric;
  responsiveness: RatingMetric;
  value: RatingMetric;
  professionalism: RatingMetric;
  trends: RatingTrend[];
  comparison: CompetitiveComparison;
}

export interface RatingMetric {
  average: number;
  count: number;
  confidenceInterval: [number, number];
  distribution: number[]; // [1-star, 2-star, 3-star, 4-star, 5-star]
  trend: 'improving' | 'declining' | 'stable';
}

export interface RatingTrend {
  period: string;
  average: number;
  count: number;
  change: number;
}

export interface CompetitiveComparison {
  categoryAverage: number;
  percentileRank: number;
  rankingPosition: number;
  totalInCategory: number;
}

// Review Insights Interface
export interface ReviewInsights {
  strengths: InsightItem[];
  improvements: InsightItem[];
  themes: ThemeAnalysis[];
  sentiment: SentimentInsights;
  recommendations: string[];
}

export interface InsightItem {
  category: string;
  description: string;
  frequency: number;
  impact: 'high' | 'medium' | 'low';
  examples: string[];
}

export interface ThemeAnalysis {
  theme: string;
  frequency: number;
  sentiment: number;
  keywords: string[];
  representative_quotes: string[];
}

export interface SentimentInsights {
  overallSentiment: number;
  sentimentTrends: { period: string; sentiment: number }[];
  emotionalIndicators: { emotion: string; frequency: number }[];
  sentimentByCategory: Record<string, number>;
}

// API Request/Response Types
export interface CreateReviewRequest extends CreateReviewData {}

export interface UpdateReviewRequest extends UpdateReviewData {}

export interface CreateResponseRequest {
  responseText: string;
  responseType?: ResponseType;
}

export interface FlagReviewRequest {
  flagReason: FlagReason;
  flagDescription?: string;
  evidenceUrls?: string[];
  additionalContext?: string;
}

export interface CreateDisputeRequest {
  disputeReason: string;
  disputeDescription: string;
  evidenceDocuments?: string[];
  witnessStatements?: string;
  additionalEvidence?: Record<string, any>;
}

export interface HelpfulnessVoteRequest {
  isHelpful: boolean;
}

// Pagination and Filtering
export interface ReviewFilters {
  rating?: number;
  verified?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  caseCategory?: string;
  consultationType?: ConsultationType;
  sortBy?: 'date' | 'rating' | 'helpfulness';
  sortOrder?: 'asc' | 'desc';
}

export interface ReviewClientSummary {
  id: string;
  firstName: string;
  lastName: string;
}

export interface ReviewResponseSummary {
  id: string;
  responseText: string;
  publishedAt?: Date;
  createdAt: Date;
  lawyerId: string;
}

export type ReviewListItem = Review & {
  client?: ReviewClientSummary;
  responses?: ReviewResponseSummary[];
};

export interface PaginatedReviews {
  reviews: ReviewListItem[];
  total: number;
  page: number;
  limit: number;
  hasNext: boolean;
  hasPrev: boolean;
}



export interface PlatformReviewStats {
  totalReviews: number;
  averageRating: number;
  totalLawyers: number;
  reviewsThisMonth: number;
  verificationRate: number;
  responseRate: number;
}

// Service Method Responses
export interface ReviewCreationResult {
  review: Review;
  fraudAnalysis: FraudAnalysis;
  validationResult: ValidationResult;
}

export interface ModerationResult {
  decision: 'approved' | 'rejected' | 'flagged';
  reason: string;
  autoModerationFlags: string[];
  moderationScore: number;
}

export interface DisputeResolutionResult {
  resolution: string;
  reviewUpdated: boolean;
  compensationOffered: boolean;
  notificationsSent: string[];
}