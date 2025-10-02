-- Migration: Create comprehensive reviews system
-- Description: Multi-dimensional rating and review platform with fraud detection and moderation

-- Reviews table - Core review data with multi-dimensional ratings
CREATE TABLE reviews (
    id VARCHAR(36) PRIMARY KEY DEFAULT (gen_random_uuid()::text),
    
    -- Review relationships
    appointment_id VARCHAR(36) REFERENCES appointments(id) NOT NULL,
    client_id VARCHAR(36) REFERENCES users(id) NOT NULL,
    lawyer_id VARCHAR(36) REFERENCES lawyer_profiles(id) NOT NULL,
    
    -- Rating dimensions (1-5 scale)
    overall_rating INTEGER NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
    communication_rating INTEGER CHECK (communication_rating BETWEEN 1 AND 5),
    expertise_rating INTEGER CHECK (expertise_rating BETWEEN 1 AND 5),
    responsiveness_rating INTEGER CHECK (responsiveness_rating BETWEEN 1 AND 5),
    value_rating INTEGER CHECK (value_rating BETWEEN 1 AND 5),
    professionalism_rating INTEGER CHECK (professionalism_rating BETWEEN 1 AND 5),
    
    -- Review content
    review_title VARCHAR(200),
    review_text TEXT,
    review_length INTEGER DEFAULT 0,
    
    -- Review context
    consultation_type VARCHAR(20), -- phone, video, in_person
    case_category VARCHAR(50), -- practice area of consultation
    recommends_lawyer BOOLEAN DEFAULT NULL,
    
    -- Verification and authenticity
    is_verified BOOLEAN DEFAULT false,
    verification_method VARCHAR(50), -- appointment_confirmed, payment_verified, etc.
    verification_score DECIMAL(5,2) DEFAULT 0.0, -- fraud detection score (0-100)
    
    -- Review status
    status VARCHAR(20) DEFAULT 'pending', -- pending, published, rejected, disputed, hidden
    moderation_status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected, flagged
    
    -- Engagement metrics
    helpful_votes INTEGER DEFAULT 0,
    unhelpful_votes INTEGER DEFAULT 0,
    total_votes INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    
    -- Quality indicators
    is_high_quality BOOLEAN DEFAULT false,
    sentiment_score DECIMAL(5,2) DEFAULT 0.0, -- -1.0 (negative) to 1.0 (positive)
    content_quality_score DECIMAL(5,2) DEFAULT 0.0,
    
    -- Edit and version control
    edit_count INTEGER DEFAULT 0,
    last_edited_at TIMESTAMP NULL,
    original_content TEXT, -- preserved original review
    
    -- Moderation details
    moderated_by VARCHAR(36) REFERENCES users(id) NULL,
    moderated_at TIMESTAMP NULL,
    moderation_notes TEXT,
    auto_moderation_flags JSONB DEFAULT '{}',
    
    -- Publishing and visibility
    published_at TIMESTAMP NULL,
    is_public BOOLEAN DEFAULT true,
    is_promoted BOOLEAN DEFAULT false, -- featured review
    
    -- Legal and compliance
    is_pinned BOOLEAN DEFAULT false, -- lawyer can pin favorite reviews
    is_disputed BOOLEAN DEFAULT false,
    dispute_resolution VARCHAR(50), -- upheld, removed, modified
    
    -- Analytics and metadata
    review_metadata JSONB DEFAULT '{}',
    user_agent TEXT,
    ip_address VARCHAR(45),
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Review responses table - Lawyer responses to reviews
CREATE TABLE review_responses (
    id VARCHAR(36) PRIMARY KEY DEFAULT (gen_random_uuid()::text),
    review_id VARCHAR(36) REFERENCES reviews(id) NOT NULL,
    lawyer_id VARCHAR(36) REFERENCES lawyer_profiles(id) NOT NULL,
    
    -- Response content
    response_text TEXT NOT NULL,
    response_length INTEGER DEFAULT 0,
    
    -- Response type and tone
    response_type VARCHAR(50) DEFAULT 'standard', -- standard, apology, clarification, dispute
    response_tone VARCHAR(50), -- professional, defensive, grateful, etc.
    
    -- Response status
    status VARCHAR(20) DEFAULT 'pending', -- pending, published, rejected
    moderation_status VARCHAR(20) DEFAULT 'pending',
    
    -- Moderation details
    moderated_by VARCHAR(36) REFERENCES users(id) NULL,
    moderated_at TIMESTAMP NULL,
    moderation_notes TEXT,
    
    -- Quality metrics
    is_helpful BOOLEAN DEFAULT false,
    helpful_votes INTEGER DEFAULT 0,
    response_quality_score DECIMAL(5,2) DEFAULT 0.0,
    
    -- Publishing
    published_at TIMESTAMP NULL,
    is_public BOOLEAN DEFAULT true,
    
    -- Edit history
    edit_count INTEGER DEFAULT 0,
    last_edited_at TIMESTAMP NULL,
    original_response TEXT,
    
    -- Analytics
    view_count INTEGER DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Review flags table - User reports and moderation flags
CREATE TABLE review_flags (
    id VARCHAR(36) PRIMARY KEY DEFAULT (gen_random_uuid()::text),
    review_id VARCHAR(36) REFERENCES reviews(id) NOT NULL,
    flagger_id VARCHAR(36) REFERENCES users(id) NOT NULL,
    
    -- Flag details
    flag_reason VARCHAR(50) NOT NULL, 
    -- fake_review, inappropriate_content, spam, off_topic, personal_attack, etc.
    flag_description TEXT,
    
    -- Flag evidence
    evidence_urls JSONB DEFAULT '[]',
    additional_context TEXT,
    
    -- Flag status
    status VARCHAR(20) DEFAULT 'pending', -- pending, investigating, resolved, dismissed
    
    -- Investigation results
    investigated_by VARCHAR(36) REFERENCES users(id) NULL,
    investigated_at TIMESTAMP NULL,
    investigation_notes TEXT,
    resolution VARCHAR(50), -- flag_upheld, flag_dismissed, review_removed, review_modified
    
    -- Flag validity
    is_valid_flag BOOLEAN NULL,
    flag_quality_score DECIMAL(5,2) DEFAULT 0.0,
    
    -- Notifications
    flagger_notified BOOLEAN DEFAULT false,
    review_author_notified BOOLEAN DEFAULT false,
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Review helpfulness table - User votes on review quality
CREATE TABLE review_helpfulness (
    id VARCHAR(36) PRIMARY KEY DEFAULT (gen_random_uuid()::text),
    review_id VARCHAR(36) REFERENCES reviews(id) NOT NULL,
    user_id VARCHAR(36) REFERENCES users(id) NOT NULL,
    
    -- Vote details
    is_helpful BOOLEAN NOT NULL,
    vote_weight DECIMAL(3,2) DEFAULT 1.0, -- user credibility weighting
    
    -- Vote context
    voter_type VARCHAR(20), -- client, lawyer, admin, verified_user
    has_booked_lawyer BOOLEAN DEFAULT false,
    
    -- Vote metadata
    user_agent TEXT,
    ip_address VARCHAR(45),
    
    created_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(review_id, user_id)
);

-- Review disputes table - Lawyer disputes of reviews
CREATE TABLE review_disputes (
    id VARCHAR(36) PRIMARY KEY DEFAULT (gen_random_uuid()::text),
    review_id VARCHAR(36) REFERENCES reviews(id) NOT NULL,
    lawyer_id VARCHAR(36) REFERENCES lawyer_profiles(id) NOT NULL,
    
    -- Dispute details
    dispute_reason VARCHAR(50) NOT NULL,
    -- factually_incorrect, defamatory, fake_review, violates_policy, personal_attack
    dispute_description TEXT NOT NULL,
    
    -- Evidence and documentation
    evidence_documents JSONB DEFAULT '[]',
    witness_statements TEXT,
    additional_evidence JSONB DEFAULT '{}',
    
    -- Dispute status
    status VARCHAR(20) DEFAULT 'submitted',
    -- submitted, under_review, resolved, rejected, appealed
    
    -- Investigation process
    assigned_investigator VARCHAR(36) REFERENCES users(id) NULL,
    investigation_started TIMESTAMP NULL,
    investigation_completed TIMESTAMP NULL,
    investigation_notes TEXT,
    
    -- Resolution details
    resolution VARCHAR(50), -- dispute_upheld, dispute_rejected, review_modified, review_removed
    resolution_reason TEXT,
    resolution_notes TEXT,
    resolved_by VARCHAR(36) REFERENCES users(id) NULL,
    resolved_at TIMESTAMP NULL,
    
    -- Appeal process
    is_appealed BOOLEAN DEFAULT false,
    appeal_reason TEXT,
    appealed_at TIMESTAMP NULL,
    appeal_resolution VARCHAR(50),
    
    -- Impact tracking
    review_modified BOOLEAN DEFAULT false,
    review_removed BOOLEAN DEFAULT false,
    compensation_offered BOOLEAN DEFAULT false,
    
    -- Timeline and SLA
    response_deadline TIMESTAMP,
    resolution_deadline TIMESTAMP,
    is_overdue BOOLEAN DEFAULT false,
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Review analytics table - Aggregated statistics
CREATE TABLE review_analytics (
    id VARCHAR(36) PRIMARY KEY DEFAULT (gen_random_uuid()::text),
    
    -- Time dimension
    date DATE NOT NULL,
    lawyer_id VARCHAR(36) REFERENCES lawyer_profiles(id) NOT NULL,
    
    -- Review volume metrics
    total_reviews INTEGER DEFAULT 0,
    new_reviews INTEGER DEFAULT 0,
    verified_reviews INTEGER DEFAULT 0,
    
    -- Rating metrics
    average_overall_rating DECIMAL(3,2) DEFAULT 0.0,
    average_communication_rating DECIMAL(3,2) DEFAULT 0.0,
    average_expertise_rating DECIMAL(3,2) DEFAULT 0.0,
    average_responsiveness_rating DECIMAL(3,2) DEFAULT 0.0,
    average_value_rating DECIMAL(3,2) DEFAULT 0.0,
    average_professionalism_rating DECIMAL(3,2) DEFAULT 0.0,
    
    -- Rating distribution
    rating_5_count INTEGER DEFAULT 0,
    rating_4_count INTEGER DEFAULT 0,
    rating_3_count INTEGER DEFAULT 0,
    rating_2_count INTEGER DEFAULT 0,
    rating_1_count INTEGER DEFAULT 0,
    
    -- Engagement metrics
    total_helpful_votes INTEGER DEFAULT 0,
    total_view_count INTEGER DEFAULT 0,
    average_review_length DECIMAL(10,2) DEFAULT 0.0,
    
    -- Quality metrics
    high_quality_review_count INTEGER DEFAULT 0,
    average_sentiment_score DECIMAL(5,2) DEFAULT 0.0,
    average_content_quality_score DECIMAL(5,2) DEFAULT 0.0,
    
    -- Response metrics
    reviews_with_responses INTEGER DEFAULT 0,
    average_response_time INTEGER DEFAULT 0, -- hours
    response_rate DECIMAL(5,2) DEFAULT 0.0, -- percentage
    
    -- Moderation metrics
    flagged_reviews INTEGER DEFAULT 0,
    removed_reviews INTEGER DEFAULT 0,
    disputed_reviews INTEGER DEFAULT 0,
    
    -- Competitive metrics
    rank_in_category INTEGER,
    percentile_rating DECIMAL(5,2),
    
    created_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(date, lawyer_id)
);

-- Create indexes for optimal performance
CREATE INDEX idx_reviews_lawyer_status ON reviews(lawyer_id, status, published_at DESC);
CREATE INDEX idx_reviews_client ON reviews(client_id, created_at DESC);
CREATE INDEX idx_reviews_appointment ON reviews(appointment_id);
CREATE INDEX idx_reviews_moderation_queue ON reviews(moderation_status, created_at);
CREATE INDEX idx_reviews_rating_trends ON reviews(lawyer_id, overall_rating, created_at);
CREATE INDEX idx_reviews_verification ON reviews(is_verified, verification_score DESC);

CREATE INDEX idx_review_responses_review ON review_responses(review_id, published_at);
CREATE INDEX idx_review_responses_lawyer ON review_responses(lawyer_id, status, created_at);

CREATE INDEX idx_review_flags_review ON review_flags(review_id, status);
CREATE INDEX idx_review_flags_flagger ON review_flags(flagger_id, created_at);
CREATE INDEX idx_review_flags_investigation ON review_flags(status, created_at);

CREATE INDEX idx_review_helpfulness_review ON review_helpfulness(review_id, is_helpful);
CREATE INDEX idx_review_helpfulness_user ON review_helpfulness(user_id, created_at);

CREATE INDEX idx_review_disputes_lawyer ON review_disputes(lawyer_id, status, created_at);
CREATE INDEX idx_review_disputes_queue ON review_disputes(status, investigation_started);
CREATE INDEX idx_review_disputes_resolution ON review_disputes(resolved_at, resolution);

CREATE INDEX idx_review_analytics_lawyer ON review_analytics(lawyer_id, date DESC);
CREATE INDEX idx_review_analytics_ratings ON review_analytics(date, average_overall_rating);

-- Add foreign key constraints and triggers for data consistency
-- Update review counts when reviews are created/updated
CREATE OR REPLACE FUNCTION update_review_counts()
RETURNS TRIGGER AS $$
BEGIN
    -- Update helpful votes count
    IF TG_TABLE_NAME = 'review_helpfulness' THEN
        UPDATE reviews 
        SET 
            helpful_votes = (
                SELECT COUNT(*) FROM review_helpfulness 
                WHERE review_id = COALESCE(NEW.review_id, OLD.review_id) AND is_helpful = true
            ),
            unhelpful_votes = (
                SELECT COUNT(*) FROM review_helpfulness 
                WHERE review_id = COALESCE(NEW.review_id, OLD.review_id) AND is_helpful = false
            ),
            total_votes = (
                SELECT COUNT(*) FROM review_helpfulness 
                WHERE review_id = COALESCE(NEW.review_id, OLD.review_id)
            ),
            updated_at = NOW()
        WHERE id = COALESCE(NEW.review_id, OLD.review_id);
    END IF;
    
    -- Update character counts
    IF TG_TABLE_NAME = 'reviews' AND NEW.review_text IS NOT NULL THEN
        NEW.review_length = LENGTH(NEW.review_text);
    END IF;
    
    IF TG_TABLE_NAME = 'review_responses' AND NEW.response_text IS NOT NULL THEN
        NEW.response_length = LENGTH(NEW.response_text);
    END IF;
    
    -- Set updated timestamp
    NEW.updated_at = NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers
CREATE TRIGGER trigger_update_review_helpfulness
    AFTER INSERT OR UPDATE OR DELETE ON review_helpfulness
    FOR EACH ROW EXECUTE FUNCTION update_review_counts();

CREATE TRIGGER trigger_update_review_length
    BEFORE INSERT OR UPDATE ON reviews
    FOR EACH ROW EXECUTE FUNCTION update_review_counts();

CREATE TRIGGER trigger_update_response_length
    BEFORE INSERT OR UPDATE ON review_responses
    FOR EACH ROW EXECUTE FUNCTION update_review_counts();

-- Insert some sample data for testing
INSERT INTO reviews (
    appointment_id, client_id, lawyer_id, overall_rating, communication_rating, 
    expertise_rating, responsiveness_rating, value_rating, professionalism_rating,
    review_title, review_text, consultation_type, case_category, recommends_lawyer,
    is_verified, verification_method, verification_score, status, moderation_status,
    is_high_quality, sentiment_score, content_quality_score, published_at, is_public
) VALUES 
(
    'sample-appointment-1', 'sample-client-1', 'sample-lawyer-1', 
    5, 5, 4, 5, 4, 5,
    'Excellent Legal Consultation',
    'Had a fantastic experience with this lawyer. Very knowledgeable about corporate law and provided clear, actionable advice. The consultation was well-structured and I felt confident about next steps. Would definitely recommend for business legal matters.',
    'video', 'corporate_law', true,
    true, 'appointment_confirmed', 85.5, 'published', 'approved',
    true, 0.8, 8.5, NOW(), true
);

-- Create view for review statistics
CREATE VIEW lawyer_review_stats AS
SELECT 
    l.id as lawyer_id,
    l.first_name,
    l.last_name,
    COUNT(r.id) as total_reviews,
    COUNT(CASE WHEN r.is_verified THEN 1 END) as verified_reviews,
    ROUND(AVG(r.overall_rating)::numeric, 2) as average_rating,
    ROUND(AVG(r.communication_rating)::numeric, 2) as avg_communication,
    ROUND(AVG(r.expertise_rating)::numeric, 2) as avg_expertise,
    ROUND(AVG(r.responsiveness_rating)::numeric, 2) as avg_responsiveness,
    ROUND(AVG(r.value_rating)::numeric, 2) as avg_value,
    ROUND(AVG(r.professionalism_rating)::numeric, 2) as avg_professionalism,
    COUNT(CASE WHEN r.overall_rating = 5 THEN 1 END) as five_star_count,
    COUNT(CASE WHEN r.overall_rating = 4 THEN 1 END) as four_star_count,
    COUNT(CASE WHEN r.overall_rating = 3 THEN 1 END) as three_star_count,
    COUNT(CASE WHEN r.overall_rating = 2 THEN 1 END) as two_star_count,
    COUNT(CASE WHEN r.overall_rating = 1 THEN 1 END) as one_star_count,
    SUM(r.helpful_votes) as total_helpful_votes,
    COUNT(CASE WHEN r.recommends_lawyer = true THEN 1 END) as recommendations,
    ROUND(AVG(r.sentiment_score)::numeric, 2) as avg_sentiment,
    COUNT(CASE WHEN r.is_high_quality THEN 1 END) as high_quality_reviews
FROM lawyer_profiles l
LEFT JOIN reviews r ON l.id = r.lawyer_id AND r.status = 'published'
GROUP BY l.id, l.first_name, l.last_name;

COMMENT ON TABLE reviews IS 'Core reviews table with multi-dimensional ratings and fraud detection';
COMMENT ON VIEW lawyer_review_stats IS 'Aggregated review statistics for lawyers';