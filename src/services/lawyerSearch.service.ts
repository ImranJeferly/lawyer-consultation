import prisma from '../config/database';
import { VerificationStatus } from '@prisma/client';

interface SearchFilters {
  search?: string;
  practiceAreas?: string[];
  location?: {
    state?: string;
    city?: string;
    radius?: number; // miles
    lat?: number;
    lng?: number;
  };
  experience?: {
    min?: number;
    max?: number;
  };
  hourlyRate?: {
    min?: number;
    max?: number;
  };
  rating?: {
    min?: number;
  };
  availability?: {
    date?: string;
    time?: string;
    duration?: number; // minutes
  };
  consultationTypes?: string[]; // phone, video, in_person
  languagesSpoken?: string[];
  verified?: boolean;
  specializations?: string[];
}

interface SearchOptions {
  page?: number;
  limit?: number;
  sortBy?: 'relevance' | 'rating' | 'experience' | 'hourlyRate' | 'distance' | 'reviews';
  sortOrder?: 'asc' | 'desc';
  includeUnavailable?: boolean;
}

interface LawyerSearchResult {
  id: string;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    profileImageUrl?: string;
    profileImageThumbnail?: string;
  };
  licenseNumber: string;
  practiceAreas: string[];
  experience: number;
  hourlyRate: number;
  bio?: string;
  rating?: number;
  totalReviews: number;
  isVerified: boolean;
  verificationStatus: VerificationStatus;
  responseTime?: string; // "Usually responds within X hours"
  consultationTypes?: any;
  languagesSpoken?: any;
  specialCertifications?: any;
  searchScore?: number; // Relevance score for search results
  distance?: number; // Distance from search location in miles
  availability?: {
    nextAvailable?: Date;
    hasAvailability?: boolean;
  };
}

interface SearchResponse {
  lawyers: LawyerSearchResult[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalCount: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  filters: {
    applied: SearchFilters;
    suggestions: {
      practiceAreas: string[];
      locationSuggestions: string[];
      experienceRange: { min: number; max: number };
      rateRange: { min: number; max: number };
    };
  };
  searchMeta: {
    searchTime: number; // milliseconds
    resultCount: number;
    searchQuery?: string;
  };
}

class LawyerSearchService {
  /**
   * Search lawyers with advanced filtering and ranking
   */
  async searchLawyers(
    filters: SearchFilters = {},
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const startTime = Date.now();

    const {
      page = 1,
      limit = 20,
      sortBy = 'relevance',
      sortOrder = 'desc',
      includeUnavailable = true
    } = options;

    const skip = (page - 1) * limit;

    try {
      // Build where conditions
      const whereConditions = await this.buildWhereConditions(filters);

      // Build order by clause
      const orderBy = this.buildOrderBy(sortBy, sortOrder, filters);

      // Execute search query
      const [lawyers, totalCount, searchSuggestions] = await Promise.all([
        this.executeLawyerQuery(whereConditions, orderBy, skip, limit, includeUnavailable),
        this.getTotalCount(whereConditions),
        this.getSearchSuggestions(filters)
      ]);

      // Calculate search scores and additional metadata
      const enrichedLawyers = await this.enrichSearchResults(lawyers, filters);

      // Sort by relevance if search query provided
      const sortedLawyers = sortBy === 'relevance' && filters.search
        ? this.sortByRelevance(enrichedLawyers, filters.search)
        : enrichedLawyers;

      const endTime = Date.now();

      return {
        lawyers: sortedLawyers,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(totalCount / limit),
          totalCount,
          hasNext: skip + limit < totalCount,
          hasPrev: page > 1
        },
        filters: {
          applied: filters,
          suggestions: searchSuggestions
        },
        searchMeta: {
          searchTime: endTime - startTime,
          resultCount: totalCount,
          searchQuery: filters.search
        }
      };
    } catch (error) {
      console.error('Lawyer search error:', error);
      throw new Error('Search failed');
    }
  }

  /**
   * Build Prisma where conditions from filters
   */
  private async buildWhereConditions(filters: SearchFilters): Promise<any> {
    const conditions: any = {
      // Only show verified lawyers by default
      verificationStatus: VerificationStatus.VERIFIED,
      isVerified: true
    };

    // Override if specifically requested
    if (filters.verified === false) {
      delete conditions.verificationStatus;
      delete conditions.isVerified;
    }

    // Text search
    if (filters.search) {
      const searchTerms = filters.search.toLowerCase().split(' ').filter(term => term.length > 0);

      conditions.OR = [
        // Search in user name
        {
          user: {
            OR: [
              { firstName: { contains: filters.search, mode: 'insensitive' } },
              { lastName: { contains: filters.search, mode: 'insensitive' } }
            ]
          }
        },
        // Search in bio
        { bio: { contains: filters.search, mode: 'insensitive' } },
        // Search in practice areas
        {
          practiceAreas: {
            hasSome: searchTerms
          }
        },
        // Search in specializations (stored in JSON)
        {
          specialCertifications: {
            path: ['$[*].name'],
            string_contains: filters.search
          }
        }
      ];
    }

    // Practice areas filter
    if (filters.practiceAreas && filters.practiceAreas.length > 0) {
      conditions.practiceAreas = {
        hasSome: filters.practiceAreas
      };
    }

    // Experience range
    if (filters.experience) {
      if (filters.experience.min !== undefined) {
        conditions.experience = { ...(typeof conditions.experience === "object" ? conditions.experience : {}), gte: filters.experience.min };
      }
      if (filters.experience.max !== undefined) {
        conditions.experience = { ...(typeof conditions.experience === "object" ? conditions.experience : {}), lte: filters.experience.max };
      }
    }

    // Hourly rate range
    if (filters.hourlyRate) {
      if (filters.hourlyRate.min !== undefined) {
        conditions.hourlyRate = { ...(typeof conditions.hourlyRate === "object" ? conditions.hourlyRate : {}), gte: filters.hourlyRate.min };
      }
      if (filters.hourlyRate.max !== undefined) {
        conditions.hourlyRate = { ...(typeof conditions.hourlyRate === "object" ? conditions.hourlyRate : {}), lte: filters.hourlyRate.max };
      }
    }

    // Rating filter
    if (filters.rating?.min !== undefined) {
      conditions.rating = { gte: filters.rating.min };
    }

    // Consultation types
    if (filters.consultationTypes && filters.consultationTypes.length > 0) {
      conditions.consultationTypes = {
        path: '$[*]',
        array_contains: filters.consultationTypes
      };
    }

    // Languages spoken
    if (filters.languagesSpoken && filters.languagesSpoken.length > 0) {
      conditions.languagesSpoken = {
        path: '$[*]',
        array_contains: filters.languagesSpoken
      };
    }

    // Location filter (bar admission state for now)
    if (filters.location?.state) {
      conditions.barAdmissionState = filters.location.state;
    }

    return conditions;
  }

  /**
   * Build order by clause
   */
  private buildOrderBy(sortBy: string, sortOrder: string, filters: SearchFilters): any {
    const order: any = {};

    switch (sortBy) {
      case 'rating':
        return [
          { rating: sortOrder },
          { totalReviews: 'desc' },
          { experience: 'desc' }
        ];

      case 'experience':
        return [
          { experience: sortOrder },
          { rating: 'desc' }
        ];

      case 'hourlyRate':
        return [
          { hourlyRate: sortOrder },
          { rating: 'desc' }
        ];

      case 'reviews':
        return [
          { totalReviews: sortOrder },
          { rating: 'desc' }
        ];

      case 'relevance':
      default:
        // For relevance, we'll sort programmatically after enrichment
        return [
          { rating: 'desc' },
          { totalReviews: 'desc' },
          { experience: 'desc' }
        ];
    }
  }

  /**
   * Execute the main lawyer query
   */
  private async executeLawyerQuery(
    whereConditions: any,
    orderBy: any,
    skip: number,
    limit: number,
    includeUnavailable: boolean
  ): Promise<any[]> {
    return await prisma.lawyerProfile.findMany({
      where: whereConditions,
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            profileImageUrl: true,
            lastActiveAt: true
          }
        },
        // Note: availability and unavailability relations don't exist in minimal schema
        // availability: includeUnavailable ? true : {
        //   where: {
        //     isAvailable: true,
        //     OR: [
        //       { effectiveUntil: null },
        //       { effectiveUntil: { gte: new Date() } }
        //     ]
        //   }
        // },
        // unavailability: {
        //   where: {
        //     endDate: { gte: new Date() }
        //   }
        // },
        // Note: _count with appointments doesn't work in minimal schema
        // _count: {
        //   select: {
        //     appointments: {
        //       where: {
        //         status: 'COMPLETED'
        //       }
        //     }
        //   }
        // }
      },
      orderBy,
      skip,
      take: limit
    });
  }

  /**
   * Get total count for pagination
   */
  private async getTotalCount(whereConditions: any): Promise<number> {
    return await prisma.lawyerProfile.count({ where: whereConditions });
  }

  /**
   * Enrich search results with additional metadata
   */
  private async enrichSearchResults(
    lawyers: any[],
    filters: SearchFilters
  ): Promise<LawyerSearchResult[]> {
    return lawyers.map(lawyer => {
      // Calculate next available slot
      const availability = this.calculateAvailability(lawyer);

      // Calculate response time based on last activity
      const responseTime = this.calculateResponseTime(lawyer.user.lastActiveAt);

      return {
        id: lawyer.id,
        user: lawyer.user,
        licenseNumber: lawyer.licenseNumber,
        practiceAreas: lawyer.practiceAreas,
        experience: lawyer.experience,
        hourlyRate: lawyer.hourlyRate,
        bio: lawyer.bio,
        rating: lawyer.rating,
        totalReviews: lawyer.totalReviews,
        isVerified: lawyer.isVerified,
        verificationStatus: lawyer.verificationStatus,
        responseTime,
        consultationTypes: lawyer.consultationTypes,
        languagesSpoken: lawyer.languagesSpoken,
        specialCertifications: lawyer.specialCertifications,
        availability,
        searchScore: 0 // Will be calculated in sortByRelevance
      };
    });
  }

  /**
   * Calculate lawyer availability
   */
  private calculateAvailability(lawyer: any): {
    nextAvailable?: Date;
    hasAvailability: boolean;
  } {
    // This is a simplified calculation
    // In a real implementation, you'd calculate based on:
    // - Current availability schedule
    // - Existing appointments
    // - Unavailability periods
    // - Minimum advance booking requirements

    const hasAvailability = lawyer.availability && lawyer.availability.length > 0;

    // Calculate next available slot (simplified)
    let nextAvailable: Date | undefined;
    if (hasAvailability) {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0); // Default to 9 AM next day
      nextAvailable = tomorrow;
    }

    return {
      nextAvailable,
      hasAvailability
    };
  }

  /**
   * Calculate response time based on last activity
   */
  private calculateResponseTime(lastActiveAt?: Date): string {
    if (!lastActiveAt) return 'Response time unknown';

    const hoursSinceActive = Math.floor(
      (Date.now() - lastActiveAt.getTime()) / (1000 * 60 * 60)
    );

    if (hoursSinceActive < 1) return 'Usually responds within 1 hour';
    if (hoursSinceActive < 24) return `Usually responds within ${hoursSinceActive + 1} hours`;
    if (hoursSinceActive < 168) return 'Usually responds within 1 day';
    return 'Response time may vary';
  }

  /**
   * Sort results by relevance score
   */
  private sortByRelevance(lawyers: LawyerSearchResult[], searchQuery: string): LawyerSearchResult[] {
    const queryTerms = searchQuery.toLowerCase().split(' ').filter(term => term.length > 0);

    return lawyers.map(lawyer => {
      let score = 0;

      // Name matching (highest status)
      const fullName = `${lawyer.user.firstName} ${lawyer.user.lastName}`.toLowerCase();
      queryTerms.forEach(term => {
        if (fullName.includes(term)) score += 100;
      });

      // Practice area matching (high status)
      lawyer.practiceAreas.forEach(area => {
        queryTerms.forEach(term => {
          if (area.toLowerCase().includes(term)) score += 50;
        });
      });

      // Bio matching (medium status)
      if (lawyer.bio) {
        const bioLower = lawyer.bio.toLowerCase();
        queryTerms.forEach(term => {
          if (bioLower.includes(term)) score += 20;
        });
      }

      // Boost score based on rating and reviews
      if (lawyer.rating) {
        score += lawyer.rating * 10;
      }
      if (lawyer.totalReviews > 0) {
        score += Math.min(lawyer.totalReviews * 2, 50);
      }

      // Boost for experience
      score += Math.min(lawyer.experience * 2, 30);

      // Boost for availability
      if (lawyer.availability?.hasAvailability) {
        score += 25;
      }

      lawyer.searchScore = score;
      return lawyer;
    }).sort((a, b) => (b.searchScore || 0) - (a.searchScore || 0));
  }

  /**
   * Get search suggestions for filters
   */
  private async getSearchSuggestions(filters: SearchFilters): Promise<{
    practiceAreas: string[];
    locationSuggestions: string[];
    experienceRange: { min: number; max: number };
    rateRange: { min: number; max: number };
  }> {
    const [practiceAreasData, experienceData, rateData, locationData] = await Promise.all([
      // Get popular practice areas
      prisma.lawyerProfile.findMany({
        where: { isVerified: true },
        select: { practiceAreas: true },
        take: 100
      }),

      // Get experience range
      prisma.lawyerProfile.aggregate({
        where: { isVerified: true },
        _min: { experience: true },
        _max: { experience: true }
      }),

      // Get rate range
      prisma.lawyerProfile.aggregate({
        where: { isVerified: true },
        _min: { hourlyRate: true },
        _max: { hourlyRate: true }
      }),

      // Get location suggestions - Note: barAdmissionState doesn't exist in minimal schema
      // prisma.lawyerProfile.findMany({
      //   where: { isVerified: true, barAdmissionState: { not: null } },
      //   select: { barAdmissionState: true },
      //   distinct: ['barAdmissionState'],
      //   take: 50
      // })
      Promise.resolve([])
    ]);

    // Extract unique practice areas
    const allPracticeAreas = practiceAreasData
      .flatMap((lawyer: any) => lawyer.practiceAreas)
      .reduce((acc: Record<string, number>, area: any) => {
        acc[area] = (acc[area] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    const popularPracticeAreas = Object.entries(allPracticeAreas)
      .sort(([,a], [,b]) => ((b as any) as number) - ((a as any) as number))
      .slice(0, 20)
      .map(([area]) => area);

    return {
      practiceAreas: popularPracticeAreas,
      locationSuggestions: [], // Note: barAdmissionState doesn't exist in minimal schema
      experienceRange: {
        min: experienceData._min.experience || 0,
        max: experienceData._max.experience || 50
      },
      rateRange: {
        min: Math.floor((rateData._min.hourlyRate || 0) / 10) * 10,
        max: Math.ceil((rateData._max.hourlyRate || 1000) / 10) * 10
      }
    };
  }

  /**
   * Get featured lawyers (trending, top-rated, etc.)
   */
  async getFeaturedLawyers(type: 'trending' | 'top-rated' | 'new' = 'top-rated', limit = 10): Promise<LawyerSearchResult[]> {
    let orderBy: any;

    switch (type) {
      case 'trending':
        // Based on recent activity and booking rate
        orderBy = [
          { user: { lastActiveAt: 'desc' } },
          { totalReviews: 'desc' },
          { rating: 'desc' }
        ];
        break;

      case 'new':
        orderBy = [
          { createdAt: 'desc' },
          { rating: 'desc' }
        ];
        break;

      case 'top-rated':
      default:
        orderBy = [
          { rating: 'desc' },
          { totalReviews: 'desc' },
          { experience: 'desc' }
        ];
        break;
    }

    const lawyers = await this.executeLawyerQuery(
      {
        verificationStatus: VerificationStatus.VERIFIED,
        isVerified: true,
        rating: { gte: 4.0 } // Only highly rated for featured
      },
      orderBy,
      0,
      limit,
      true
    );

    return await this.enrichSearchResults(lawyers, {});
  }

  /**
   * Get similar lawyers based on practice areas and experience
   */
  async getSimilarLawyers(lawyerId: string, limit = 5): Promise<LawyerSearchResult[]> {
    const targetLawyer = await prisma.lawyerProfile.findUnique({
      where: { id: lawyerId },
      select: { practiceAreas: true, experience: true, hourlyRate: true }
    });

    if (!targetLawyer) return [];

    const lawyers = await this.executeLawyerQuery(
      {
        verificationStatus: VerificationStatus.VERIFIED,
        isVerified: true,
        id: { not: lawyerId },
        practiceAreas: {
          hasSome: targetLawyer.practiceAreas
        },
        experience: {
          gte: Math.max(0, targetLawyer.experience - 5),
          lte: targetLawyer.experience + 5
        }
      },
      [
        { rating: 'desc' },
        { totalReviews: 'desc' }
      ],
      0,
      limit,
      true
    );

    return await this.enrichSearchResults(lawyers, {});
  }
}

export default new LawyerSearchService();