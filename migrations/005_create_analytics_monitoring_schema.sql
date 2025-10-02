-- Complete Analytics & Monitoring Database Schema
-- This creates the foundation for comprehensive platform analytics

-- ====================================================================
-- 1. EVENT TRACKING TABLE - Core event collection
-- ====================================================================
CREATE TABLE event_tracking (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Event identification
    event_name VARCHAR(100) NOT NULL, -- user_registered, booking_created, etc.
    event_category VARCHAR(50) NOT NULL, -- user, booking, payment, system
    event_action VARCHAR(50) NOT NULL, -- create, update, delete, view
    
    -- Event context
    user_id VARCHAR REFERENCES users(id), -- null for anonymous events
    session_id VARCHAR(100), -- user session identifier
    
    -- Event metadata
    event_properties JSONB DEFAULT '{}', -- custom event properties and data
    event_value DECIMAL(10,2), -- monetary value if applicable
    
    -- Technical context
    user_agent TEXT,
    ip_address VARCHAR(45),
    device_type VARCHAR(20), -- desktop, mobile, tablet
    browser_name VARCHAR(50),
    operating_system VARCHAR(50),
    
    -- Location context
    country VARCHAR(2),
    state VARCHAR(50),
    city VARCHAR(100),
    timezone VARCHAR(50),
    
    -- Referral and attribution
    referrer_url TEXT,
    utm_source VARCHAR(100),
    utm_medium VARCHAR(100),
    utm_campaign VARCHAR(100),
    utm_term VARCHAR(100),
    utm_content VARCHAR(100),
    
    -- Page and feature context
    page_url TEXT,
    feature_name VARCHAR(100),
    component_name VARCHAR(100),
    
    -- Timing and performance
    event_timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    page_load_time INTEGER, -- milliseconds
    server_processing_time INTEGER, -- milliseconds
    
    -- Experiment and testing
    experiment_id VARCHAR(100), -- A/B test identifier
    experiment_variant VARCHAR(50), -- test variant (A, B, control)
    
    -- Data quality
    is_valid BOOLEAN DEFAULT true,
    validation_errors JSONB DEFAULT '{}',
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for optimal query performance
CREATE INDEX idx_event_tracking_user ON event_tracking(user_id, event_timestamp DESC);
CREATE INDEX idx_event_tracking_category ON event_tracking(event_category, event_action, event_timestamp DESC);
CREATE INDEX idx_event_tracking_session ON event_tracking(session_id, event_timestamp DESC);
CREATE INDEX idx_event_tracking_experiment ON event_tracking(experiment_id, experiment_variant);
CREATE INDEX idx_event_tracking_timestamp ON event_tracking(event_timestamp DESC);
CREATE INDEX idx_event_tracking_properties ON event_tracking USING GIN(event_properties);

-- ====================================================================
-- 2. SYSTEM METRICS TABLE - Technical performance monitoring
-- ====================================================================
CREATE TABLE system_metrics (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Metric identification
    metric_name VARCHAR(100) NOT NULL, -- api_response_time, cpu_usage, etc.
    metric_type VARCHAR(50) NOT NULL, -- gauge, counter, histogram, timer
    component VARCHAR(50) NOT NULL, -- api, database, worker, frontend
    
    -- Metric values
    value DECIMAL(15,6) NOT NULL,
    unit VARCHAR(20), -- ms, seconds, percentage, count
    
    -- Aggregation data
    min_value DECIMAL(15,6),
    max_value DECIMAL(15,6),
    avg_value DECIMAL(15,6),
    sum_value DECIMAL(15,6),
    count INTEGER,
    
    -- Dimensions and tags
    tags JSONB DEFAULT '{}', -- {endpoint: "/api/users", method: "GET", status: 200}
    dimensions JSONB DEFAULT '{}', -- additional metric dimensions
    
    -- Time and granularity
    timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    granularity VARCHAR(20) DEFAULT 'minute', -- second, minute, hour, day
    
    -- Alert and threshold data
    threshold DECIMAL(15,6), -- alert threshold if applicable
    is_alert_triggered BOOLEAN DEFAULT false,
    alert_level VARCHAR(20), -- info, warning, error, critical
    
    -- Data retention
    retention_days INTEGER DEFAULT 90,
    
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for system metrics
CREATE INDEX idx_system_metrics_component ON system_metrics(component, metric_name, timestamp DESC);
CREATE INDEX idx_system_metrics_alerts ON system_metrics(is_alert_triggered, alert_level, timestamp DESC);
CREATE INDEX idx_system_metrics_retention ON system_metrics(timestamp, retention_days);
CREATE INDEX idx_system_metrics_tags ON system_metrics USING GIN(tags);

-- ====================================================================
-- 3. BUSINESS METRICS TABLE - KPI and business intelligence
-- ====================================================================
CREATE TABLE business_metrics (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Time dimension
    date DATE NOT NULL,
    hour INTEGER, -- 0-23 for hourly metrics, null for daily
    
    -- Business KPIs
    total_revenue DECIMAL(12,2) DEFAULT 0,
    platform_revenue DECIMAL(12,2) DEFAULT 0,
    lawyer_earnings DECIMAL(12,2) DEFAULT 0,
    
    -- User metrics
    total_users INTEGER DEFAULT 0,
    new_users INTEGER DEFAULT 0,
    active_users INTEGER DEFAULT 0,
    returning_users INTEGER DEFAULT 0,
    
    -- Lawyer metrics
    total_lawyers INTEGER DEFAULT 0,
    new_lawyers INTEGER DEFAULT 0,
    active_lawyers INTEGER DEFAULT 0,
    verified_lawyers INTEGER DEFAULT 0,
    
    -- Booking metrics
    total_bookings INTEGER DEFAULT 0,
    new_bookings INTEGER DEFAULT 0,
    completed_bookings INTEGER DEFAULT 0,
    cancelled_bookings INTEGER DEFAULT 0,
    booking_value DECIMAL(12,2) DEFAULT 0,
    
    -- Conversion metrics
    search_to_booking_rate DECIMAL(5,2) DEFAULT 0,
    signup_to_booking_rate DECIMAL(5,2) DEFAULT 0,
    visit_to_signup_rate DECIMAL(5,2) DEFAULT 0,
    
    -- Engagement metrics
    average_session_duration INTEGER DEFAULT 0, -- seconds
    pages_per_session DECIMAL(5,2) DEFAULT 0,
    bounce_rate DECIMAL(5,2) DEFAULT 0,
    
    -- Quality metrics
    average_rating DECIMAL(3,2) DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    customer_satisfaction_score DECIMAL(5,2) DEFAULT 0,
    
    -- Financial health
    customer_acquisition_cost DECIMAL(10,2) DEFAULT 0,
    customer_lifetime_value DECIMAL(10,2) DEFAULT 0,
    monthly_recurring_revenue DECIMAL(12,2) DEFAULT 0,
    churn_rate DECIMAL(5,2) DEFAULT 0,
    
    -- Geographic dimensions
    country VARCHAR(2),
    state VARCHAR(50),
    city VARCHAR(100),
    
    -- Segment dimensions
    user_segment VARCHAR(50), -- premium, standard, new, returning
    practice_area_category VARCHAR(50),
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Unique constraints and indexes for business metrics
CREATE UNIQUE INDEX idx_business_metrics_hourly ON business_metrics(date, hour, country, state, city, user_segment) WHERE hour IS NOT NULL;
CREATE UNIQUE INDEX idx_business_metrics_daily ON business_metrics(date, country, state, city, user_segment) WHERE hour IS NULL;
CREATE INDEX idx_business_metrics_date ON business_metrics(date DESC, hour DESC);
CREATE INDEX idx_business_metrics_location ON business_metrics(country, state, city);
CREATE INDEX idx_business_metrics_segment ON business_metrics(user_segment, practice_area_category);

-- ====================================================================
-- 4. USER JOURNEYS TABLE - User behavior and conversion tracking
-- ====================================================================
CREATE TABLE user_journeys (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Journey identification
    user_id VARCHAR REFERENCES users(id),
    session_id VARCHAR(100) NOT NULL,
    journey_type VARCHAR(50) NOT NULL, -- onboarding, booking, payment, etc.
    
    -- Journey progress
    current_step VARCHAR(100) NOT NULL,
    total_steps INTEGER NOT NULL,
    completed_steps INTEGER DEFAULT 0,
    
    -- Journey outcome
    is_completed BOOLEAN DEFAULT false,
    is_abandoned BOOLEAN DEFAULT false,
    abandonment_reason VARCHAR(100),
    abandonment_step VARCHAR(100),
    
    -- Timing metrics
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP,
    abandoned_at TIMESTAMP,
    total_duration INTEGER, -- seconds from start to completion/abandonment
    
    -- Journey path
    step_sequence JSONB DEFAULT '[]', -- array of steps taken
    action_sequence JSONB DEFAULT '[]', -- detailed action log
    
    -- Context and attribution
    entry_point VARCHAR(100), -- how user entered this journey
    referral_source VARCHAR(100),
    campaign_source VARCHAR(100),
    
    -- User characteristics
    user_type VARCHAR(50), -- new, returning, premium
    device_type VARCHAR(20),
    is_first_time_journey BOOLEAN DEFAULT false,
    
    -- Journey value
    conversion_value DECIMAL(10,2), -- monetary value if applicable
    goal_achieved BOOLEAN DEFAULT false,
    
    -- A/B testing
    experiment_id VARCHAR(100),
    experiment_variant VARCHAR(50),
    
    -- Journey metadata
    journey_metadata JSONB DEFAULT '{}',
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for user journeys
CREATE INDEX idx_user_journeys_user ON user_journeys(user_id, started_at DESC);
CREATE INDEX idx_user_journeys_session ON user_journeys(session_id, started_at DESC);
CREATE INDEX idx_user_journeys_type ON user_journeys(journey_type, is_completed, started_at DESC);
CREATE INDEX idx_user_journeys_experiment ON user_journeys(experiment_id, experiment_variant);
CREATE INDEX idx_user_journeys_completion ON user_journeys(is_completed, is_abandoned, started_at DESC);

-- ====================================================================
-- 5. SYSTEM ALERTS TABLE - Alert management and tracking
-- ====================================================================
CREATE TABLE system_alerts (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Alert identification
    alert_name VARCHAR(100) NOT NULL,
    alert_type VARCHAR(50) NOT NULL, -- performance, error, security, business
    severity VARCHAR(20) NOT NULL, -- info, warning, error, critical
    
    -- Alert details
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    component VARCHAR(50) NOT NULL, -- api, database, payment, etc.
    
    -- Alert conditions
    metric_name VARCHAR(100),
    threshold DECIMAL(15,6),
    actual_value DECIMAL(15,6),
    condition VARCHAR(50), -- greater_than, less_than, equals, not_equals
    
    -- Alert status
    status VARCHAR(20) DEFAULT 'active', -- active, acknowledged, resolved, suppressed
    acknowledged_by VARCHAR REFERENCES users(id),
    acknowledged_at TIMESTAMP,
    resolved_by VARCHAR REFERENCES users(id),
    resolved_at TIMESTAMP,
    
    -- Alert timing
    triggered_at TIMESTAMP NOT NULL DEFAULT NOW(),
    first_occurrence TIMESTAMP,
    last_occurrence TIMESTAMP,
    occurrence_count INTEGER DEFAULT 1,
    
    -- Impact assessment
    affected_users INTEGER DEFAULT 0,
    affected_revenue DECIMAL(12,2) DEFAULT 0,
    impact_level VARCHAR(20), -- low, medium, high, critical
    
    -- Resolution tracking
    resolution_notes TEXT,
    root_cause TEXT,
    prevention_measures TEXT,
    time_to_resolution INTEGER, -- minutes from trigger to resolution
    
    -- Notification tracking
    notifications_sent INTEGER DEFAULT 0,
    escalation_level INTEGER DEFAULT 0,
    last_notification_sent TIMESTAMP,
    
    -- Alert metadata
    alert_metadata JSONB DEFAULT '{}',
    tags JSONB DEFAULT '{}',
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for system alerts
CREATE INDEX idx_system_alerts_status ON system_alerts(status, severity, triggered_at DESC);
CREATE INDEX idx_system_alerts_component ON system_alerts(component, alert_type, triggered_at DESC);
CREATE INDEX idx_system_alerts_resolution ON system_alerts(resolved_at, time_to_resolution);
CREATE INDEX idx_system_alerts_active ON system_alerts(status, severity) WHERE status = 'active';

-- ====================================================================
-- 6. EXPERIMENT RESULTS TABLE - A/B testing and experimentation
-- ====================================================================
CREATE TABLE experiment_results (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Experiment identification
    experiment_id VARCHAR(100) NOT NULL UNIQUE,
    experiment_name VARCHAR(200) NOT NULL,
    experiment_type VARCHAR(50) NOT NULL, -- ab_test, multivariate, feature_flag
    
    -- Experiment configuration
    hypothesis TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,
    target_sample_size INTEGER,
    
    -- Variant details
    variants JSONB NOT NULL, -- [{name: "control", traffic: 50}, {name: "variant_a", traffic: 50}]
    
    -- Results summary
    total_participants INTEGER DEFAULT 0,
    conversion_rate DECIMAL(5,2) DEFAULT 0,
    statistical_significance DECIMAL(5,2) DEFAULT 0,
    confidence_level DECIMAL(5,2) DEFAULT 95.0,
    
    -- Variant performance
    variant_results JSONB DEFAULT '{}', -- detailed results by variant
    winning_variant VARCHAR(50),
    lift_percentage DECIMAL(5,2) DEFAULT 0,
    
    -- Metrics tracked
    primary_metric VARCHAR(100) NOT NULL, -- conversion_rate, revenue, engagement
    secondary_metrics JSONB DEFAULT '[]', -- additional metrics being tracked
    
    -- Statistical analysis
    p_value DECIMAL(10,8),
    z_score DECIMAL(10,6),
    effect_size DECIMAL(10,6),
    
    -- Experiment status
    status VARCHAR(20) DEFAULT 'running', -- planning, running, completed, paused, cancelled
    conclusion TEXT,
    recommendations TEXT,
    
    -- Business impact
    projected_impact DECIMAL(12,2), -- estimated annual impact if implemented
    implementation_cost DECIMAL(12,2),
    roi DECIMAL(10,2), -- return on investment percentage
    
    -- Quality metrics
    data_quality DECIMAL(5,2) DEFAULT 100.0, -- percentage of valid data
    bias_indicators JSONB DEFAULT '{}', -- potential bias in results
    
    -- Timeline tracking
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for experiment results
CREATE INDEX idx_experiment_results_status ON experiment_results(status, start_date);
CREATE INDEX idx_experiment_results_performance ON experiment_results(conversion_rate, statistical_significance);
CREATE INDEX idx_experiment_results_timeline ON experiment_results(start_date DESC, end_date DESC);

-- ====================================================================
-- 7. ANALYTICS CACHE TABLE - Pre-computed analytics for performance
-- ====================================================================
CREATE TABLE analytics_cache (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Cache identification
    cache_key VARCHAR(200) NOT NULL UNIQUE,
    cache_type VARCHAR(50) NOT NULL, -- dashboard, report, metric
    
    -- Cache content
    data JSONB NOT NULL,
    metadata JSONB DEFAULT '{}',
    
    -- Cache validity
    expires_at TIMESTAMP NOT NULL,
    is_valid BOOLEAN DEFAULT true,
    
    -- Cache statistics
    hit_count INTEGER DEFAULT 0,
    last_accessed TIMESTAMP DEFAULT NOW(),
    computation_time INTEGER, -- milliseconds to compute
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for analytics cache
CREATE INDEX idx_analytics_cache_key ON analytics_cache(cache_key, is_valid);
CREATE INDEX idx_analytics_cache_expiry ON analytics_cache(expires_at, is_valid);
CREATE INDEX idx_analytics_cache_type ON analytics_cache(cache_type, expires_at);

-- ====================================================================
-- 8. FEATURE USAGE TABLE - Track feature adoption and usage
-- ====================================================================
CREATE TABLE feature_usage (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Feature identification
    feature_name VARCHAR(100) NOT NULL,
    feature_category VARCHAR(50) NOT NULL, -- core, premium, experimental
    
    -- Usage context
    user_id VARCHAR REFERENCES users(id),
    session_id VARCHAR(100),
    
    -- Usage metrics
    usage_count INTEGER DEFAULT 1,
    usage_duration INTEGER, -- seconds spent using feature
    last_used_at TIMESTAMP DEFAULT NOW(),
    
    -- Feature state
    is_active BOOLEAN DEFAULT true,
    feature_version VARCHAR(20),
    
    -- User experience
    satisfaction_score INTEGER, -- 1-5 rating if provided
    feedback_provided TEXT,
    
    -- Date partitioning
    usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
    
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for feature usage
CREATE INDEX idx_feature_usage_user ON feature_usage(user_id, usage_date DESC);
CREATE INDEX idx_feature_usage_feature ON feature_usage(feature_name, usage_date DESC);
CREATE INDEX idx_feature_usage_date ON feature_usage(usage_date DESC, feature_category);

-- ====================================================================
-- DATA RETENTION AND CLEANUP POLICIES
-- ====================================================================

-- Create function for automated data cleanup
CREATE OR REPLACE FUNCTION cleanup_analytics_data()
RETURNS void AS $$
BEGIN
    -- Clean up expired cache entries
    DELETE FROM analytics_cache WHERE expires_at < NOW() AND is_valid = false;
    
    -- Archive old event tracking data (keep 2 years)
    DELETE FROM event_tracking WHERE event_timestamp < NOW() - INTERVAL '2 years';
    
    -- Archive old system metrics based on retention policy
    DELETE FROM system_metrics WHERE timestamp < NOW() - INTERVAL '1 day' * retention_days;
    
    -- Clean up resolved alerts older than 1 year
    DELETE FROM system_alerts WHERE resolved_at < NOW() - INTERVAL '1 year';
    
    -- Archive completed user journeys older than 1 year
    DELETE FROM user_journeys WHERE (completed_at < NOW() - INTERVAL '1 year' OR abandoned_at < NOW() - INTERVAL '1 year');
    
END;
$$ LANGUAGE plpgsql;

-- Create indexes for better performance
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_tracking_cleanup ON event_tracking(event_timestamp) WHERE event_timestamp < NOW() - INTERVAL '1 year';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_system_metrics_cleanup ON system_metrics(timestamp, retention_days);

-- Add comments for documentation
COMMENT ON TABLE event_tracking IS 'Stores all user interactions and system events for analytics';
COMMENT ON TABLE system_metrics IS 'Real-time system performance and health metrics';
COMMENT ON TABLE business_metrics IS 'Aggregated business KPIs and performance indicators';
COMMENT ON TABLE user_journeys IS 'User behavior and conversion funnel tracking';
COMMENT ON TABLE system_alerts IS 'System monitoring alerts and incident management';
COMMENT ON TABLE experiment_results IS 'A/B testing and experimentation results';
COMMENT ON TABLE analytics_cache IS 'Pre-computed analytics data for performance optimization';
COMMENT ON TABLE feature_usage IS 'Feature adoption and usage analytics';

-- Success message
SELECT 'Analytics and Monitoring Database Schema Created Successfully! 🎉' as status;