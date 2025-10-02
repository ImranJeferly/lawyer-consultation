-- Migration: create lawyer_review_stats table for aggregated review metrics
CREATE TABLE IF NOT EXISTS lawyer_review_stats (
    lawyer_id TEXT PRIMARY KEY REFERENCES lawyer_profiles(id) ON DELETE CASCADE,
    average_rating DOUBLE PRECISION DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    rating_distribution JSONB NOT NULL DEFAULT '{}'::jsonb,
    verified_review_count INTEGER DEFAULT 0,
    recommendation_rate DOUBLE PRECISION DEFAULT 0,
    reviews_with_responses INTEGER DEFAULT 0,
    average_response_time DOUBLE PRECISION DEFAULT 0,
    average_sentiment_score DOUBLE PRECISION DEFAULT 0,
    average_content_quality_score DOUBLE PRECISION DEFAULT 0,
    high_quality_review_count INTEGER DEFAULT 0,
    sentiment_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
    dimensional_averages JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_computed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
