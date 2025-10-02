import {
  PrismaClient,
  Document,
  DocumentType,
  DocumentCategory,
  SecurityLevel,
  DocumentShare,
  DocumentSignature,
  WorkflowStatus,
} from '@prisma/client';
import prisma from '../config/database';
import { ensureDocumentSearchIndex, getDocumentSearchClient, DocumentSearchIndex } from '../config/search';

interface SearchOptions {
  query: string;
  userId: string;
  filters?: {
    documentType?: DocumentType;
    category?: DocumentCategory;
    securityLevel?: SecurityLevel[];
    dateRange?: {
      from: Date;
      to: Date;
    };
    fileSize?: {
      min?: number;
      max?: number;
    };
    tags?: string[];
    folderId?: string;
    ownerId?: string;
    sharedWithMe?: boolean;
  };
  sortBy?: 'relevance' | 'date' | 'name' | 'size';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

interface SearchResult {
  document: Document & {
    owner: { id: string; firstName: string; lastName: string };
    folder?: { id: string; name: string; path: string };
  };
  relevanceScore: number;
  matchedFields: string[];
  highlights: {
    field: string;
    snippet: string;
    position: number;
  }[];
  excerpt: string;
}

interface SearchResponse {
  results: SearchResult[];
  totalResults: number;
  facets: {
    documentTypes: Array<{ type: DocumentType; count: number }>;
    categories: Array<{ category: DocumentCategory; count: number }>;
    tags: Array<{ tag: string; count: number }>;
    owners: Array<{ ownerId: string; ownerName: string; count: number }>;
  };
  searchTime: number;
  suggestions: string[];
}

interface IndexingStats {
  totalDocuments: number;
  indexedDocuments: number;
  pendingIndexing: number;
  lastIndexingRun: Date;
  indexingErrors: number;
  averageIndexingTime: number;
}

interface IndexedDocumentRecord {
  id: string;
  title: string;
  description: string;
  fileName: string;
  ownerId: string;
  createdBy: string;
  folderId: string | null;
  documentType: DocumentType;
  category: DocumentCategory;
  practiceArea: string | null;
  securityLevel: SecurityLevel;
  tags: string[];
  searchableText: string;
  allowedUserIds: string[];
  signedUserIds: string[];
  createdAt: string;
  updatedAt: string;
  fileSize: number;
}

type MeilisearchHit = IndexedDocumentRecord & {
  _formatted?: Record<string, string>;
  _matchesPosition?: Record<string, unknown>;
  _rankingScore?: number;
};

class DocumentSearchService {

  private searchIndexPromise: Promise<DocumentSearchIndex | null> | null = null;

  private async resolveSearchIndex(): Promise<DocumentSearchIndex | null> {
    if (!this.searchIndexPromise) {
      this.searchIndexPromise = ensureDocumentSearchIndex().catch((error) => {
        console.error('Failed to resolve search index:', error);
        return null;
      });
    }

    return this.searchIndexPromise;
  }

  /**
   * Perform full-text search across documents
   */
  async searchDocuments(options: SearchOptions): Promise<SearchResponse> {
    const index = await this.resolveSearchIndex();

    if (!index || !getDocumentSearchClient()) {
      return this.searchDocumentsWithDatabase(options);
    }

    return this.searchDocumentsWithIndex(index, options);
  }

  private async searchDocumentsWithDatabase(options: SearchOptions): Promise<SearchResponse> {
    const startTime = Date.now();

    try {
      // Build base query for documents user has access to
      const baseWhere = this.buildAccessQuery(options.userId);

      // Add search filters
      const searchWhere = this.buildSearchFilters(options);

      // Combine access and search conditions
      const whereCondition = {
        AND: [baseWhere, searchWhere]
      };

      // Perform text search
      const searchResults = await this.executeTextSearch(options.query, whereCondition, options);

      // Calculate relevance scores and highlights
      const scoredResults = await this.calculateRelevanceScores(searchResults, options.query);

      // Apply sorting
      const sortedResults = this.applySorting(scoredResults, options.sortBy, options.sortOrder);

      // Apply pagination
      const paginatedResults = this.applyPagination(sortedResults, options.limit, options.offset);

      // Get facet counts
      const facets = await this.calculateFacets(whereCondition);

      // Generate search suggestions
      const suggestions = await this.generateSuggestions(options.query);

      const searchTime = Date.now() - startTime;

      return {
        results: paginatedResults,
        totalResults: scoredResults.length,
        facets,
        searchTime,
        suggestions
      };

    } catch (error) {
      console.error('Search failed:', error);
      return {
        results: [],
        totalResults: 0,
        facets: {
          documentTypes: [],
          categories: [],
          tags: [],
          owners: []
        },
        searchTime: Date.now() - startTime,
        suggestions: []
      };
    }
  }

  private async searchDocumentsWithIndex(
    index: DocumentSearchIndex,
    options: SearchOptions
  ): Promise<SearchResponse> {
    const startTime = Date.now();

    try {
      const filters = this.buildIndexFilters(options);
      const sort = this.buildIndexSort(options.sortBy, options.sortOrder);

      const searchResponse = await index.search<IndexedDocumentRecord>(options.query || '', {
        filter: filters.length ? filters : undefined,
        limit: options.limit ?? 20,
        offset: options.offset ?? 0,
        sort: sort ? [sort] : undefined,
        facets: ['documentType', 'category', 'tags', 'ownerId', 'securityLevel'],
        attributesToHighlight: ['title', 'description', 'searchableText'],
        highlightPreTag: '<mark>',
        highlightPostTag: '</mark>',
      });

      const hits = (searchResponse.hits ?? []) as MeilisearchHit[];
      const documentIds = hits
        .map((hit) => hit.id)
        .filter((id): id is string => Boolean(id));

      if (!documentIds.length) {
        const facets = await this.transformFacetDistribution(searchResponse.facetDistribution);
        return {
          results: [],
          totalResults: 0,
          facets,
          searchTime: searchResponse.processingTimeMs ?? Date.now() - startTime,
          suggestions: await this.generateSuggestions(options.query),
        };
      }

      const accessWhere = this.buildAccessQuery(options.userId);

      const documents = await prisma.document.findMany({
        where: {
          AND: [accessWhere, { id: { in: documentIds } }],
        },
        include: {
          owner: {
            select: { id: true, firstName: true, lastName: true },
          },
          folder: {
            select: { id: true, name: true, path: true },
          },
        },
      }) as Array<SearchResult['document']>;

      const documentMap = new Map<string, SearchResult['document']>(
        documents.map((doc) => [doc.id, doc])
      );
      const staleDocumentIds: string[] = [];
      const results: SearchResult[] = [];

      for (const hit of hits) {
        const document = hit.id ? documentMap.get(hit.id) : undefined;
        if (!document) {
          if (hit.id) {
            staleDocumentIds.push(hit.id);
          }
          continue;
        }

        const rankingScore = typeof hit._rankingScore === 'number'
          ? hit._rankingScore
          : 0;
        const matchesPosition = (hit._matchesPosition ?? {}) as Record<string, unknown>;
        const matchedFields = Object.keys(matchesPosition);
        const formatted = (hit._formatted ?? {}) as Record<string, string>;

        const highlights: SearchResult['highlights'] = [];
        ['title', 'description', 'searchableText'].forEach((field) => {
          const value = formatted[field];
          if (typeof value === 'string' && value.includes('<mark>')) {
            highlights.push({ field, snippet: value, position: 0 });
          }
        });

        const excerpt = typeof formatted.searchableText === 'string'
          ? formatted.searchableText
          : this.generateExcerpt(
              document.extractedText || document.description || document.fileName,
              this.preprocessQuery(options.query || '')
            );

        results.push({
          document,
          relevanceScore: rankingScore,
          matchedFields,
          highlights,
          excerpt,
        });
      }

      if (staleDocumentIds.length) {
        index.deleteDocuments(staleDocumentIds).catch((error: unknown) => {
          console.warn('Failed to remove stale documents from search index:', error);
        });
      }

      const totalResults = searchResponse.estimatedTotalHits ?? results.length;
      const searchTime = searchResponse.processingTimeMs ?? Date.now() - startTime;
      const suggestions = await this.generateSuggestions(options.query);
      const facets = await this.transformFacetDistribution(searchResponse.facetDistribution);

      return {
        results,
        totalResults,
        facets,
        searchTime,
        suggestions,
      };

    } catch (error) {
      console.error('Indexed search failed, falling back to database search:', error);
      return this.searchDocumentsWithDatabase(options);
    }
  }

  /**
   * Index document for search
   */
  async indexDocument(documentId: string): Promise<boolean> {
    let index: DocumentSearchIndex | null = null;

    try {
      index = await this.resolveSearchIndex();

      const document = await prisma.document.findUnique({
        where: { id: documentId },
        include: {
          owner: {
            select: { id: true, firstName: true, lastName: true },
          },
          folder: {
            select: { id: true, name: true, path: true },
          },
          shares: {
            where: { isActive: true },
            select: { sharedWith: true, isActive: true, expiresAt: true },
          },
          signatures: {
            select: { signerId: true },
          },
        },
      });

      if (!document) {
        throw new Error('Document not found');
      }

      if (index) {
        const record = this.buildIndexRecord(document);
        await index.addDocuments([record]);
      }

      return true;

    } catch (error) {
      console.error('Failed to index document:', error);

      return false;
    }
  }

  /**
   * Bulk index multiple documents
   */
  async bulkIndexDocuments(documentIds: string[]): Promise<{
    successful: number;
    failed: number;
    errors: Array<{ documentId: string; error: string }>;
  }> {
    const index = await this.resolveSearchIndex();
    const results = {
      successful: 0,
      failed: 0,
      errors: [] as Array<{ documentId: string; error: string }>
    };

    for (const documentId of documentIds) {
      try {
        const success = await this.indexDocument(documentId);
        if (success) {
          results.successful++;
        } else {
          results.failed++;
          results.errors.push({ documentId, error: 'Indexing failed' });
          if (index) {
            await index.deleteDocument(documentId).catch(() => undefined);
          }
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          documentId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        if (index) {
          await index.deleteDocument(documentId).catch(() => undefined);
        }
      }
    }

    return results;
  }

  /**
   * Re-index all documents (background job)
   */
  async reindexAllDocuments(): Promise<IndexingStats> {
    const startTime = Date.now();

    const stats: IndexingStats = {
      totalDocuments: 0,
      indexedDocuments: 0,
      pendingIndexing: 0,
      lastIndexingRun: new Date(),
      indexingErrors: 0,
      averageIndexingTime: 0
    };

    try {
      const index = await this.resolveSearchIndex();
      if (index) {
        await index.deleteAllDocuments();
      }

      // Get all documents that need indexing
      const documents = await prisma.document.findMany({
        where: {
          workflowStatus: { not: WorkflowStatus.DRAFT }
          // Remove OR conditions with non-existent fields
          // OR: [
          //   { isIndexed: false },
          //   { lastIndexedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } // Older than 24 hours
          // ]
        },
        select: { id: true }
      });

      stats.totalDocuments = documents.length;
      stats.pendingIndexing = documents.length;

      const batchSize = 100;
      for (let i = 0; i < documents.length; i += batchSize) {
        const batch = documents.slice(i, i + batchSize);
        const batchIds = batch.map(d => d.id);

        const batchResults = await this.bulkIndexDocuments(batchIds);
        stats.indexedDocuments += batchResults.successful;
        stats.indexingErrors += batchResults.failed;

        // Update progress
        console.log(`Indexed ${i + batch.length}/${documents.length} documents`);
      }

      const endTime = Date.now();
      stats.averageIndexingTime = (endTime - startTime) / stats.totalDocuments;

      // Update indexing statistics in database
      await this.updateIndexingStats(stats);

      return stats;

    } catch (error) {
      console.error('Failed to reindex documents:', error);
      return stats;
    }
  }

  /**
   * Search for similar documents
   */
  async findSimilarDocuments(documentId: string, userId: string, limit: number = 10): Promise<SearchResult[]> {
    try {
      // Get the source document
      const sourceDocument = await prisma.document.findFirst({
        where: {
          id: documentId,
          OR: [
            { ownerId: userId },
            {
              // TODO: Fix sharing relationship - shares field doesn't exist
              // shares: {
              //   some: {
              //     sharedWithUserId: userId,
              //     status: 'ACTIVE'
              //   }
              // }
              createdBy: userId // Alternative check for accessible documents
            }
          ]
        }
      });

      if (!sourceDocument) {
        return [];
      }

      // Extract key terms from the source document
      // Use title or description as fallback since searchableContent doesn't exist
      const searchText = sourceDocument.title || sourceDocument.description || '';
      const keyTerms = this.extractKeyTerms(searchText);
      const searchQuery = keyTerms.slice(0, 10).join(' '); // Use top 10 terms

      // Search for similar documents
      const searchOptions: SearchOptions = {
        query: searchQuery,
        userId,
        filters: {
          category: sourceDocument.category,
          documentType: sourceDocument.documentType
        },
        sortBy: 'relevance',
        limit
      };

      const results = await this.searchDocuments(searchOptions);

      // Filter out the source document itself
      return results.results.filter(result => result.document.id !== documentId);

    } catch (error) {
      console.error('Failed to find similar documents:', error);
      return [];
    }
  }

  /**
   * Get search suggestions based on query
   */
  async getSearchSuggestions(partialQuery: string, userId: string, limit: number = 10): Promise<string[]> {
    try {
      // Get frequently searched terms
      const suggestions = await this.generateSuggestions(partialQuery, limit);

      // Add document-specific suggestions
      const documentSuggestions = await this.getDocumentBasedSuggestions(partialQuery, userId, 5);

      // Combine and deduplicate
      const allSuggestions = [...suggestions, ...documentSuggestions];
      const uniqueSuggestions = Array.from(new Set(allSuggestions));

      return uniqueSuggestions.slice(0, limit);

    } catch (error) {
      console.error('Failed to get search suggestions:', error);
      return [];
    }
  }

  /**
   * Private helper methods
   */

  /**
   * Build query for documents user has access to
   */
  private buildAccessQuery(userId: string) {
    return {
      OR: [
        { ownerId: userId },
        { createdBy: userId },
        {
          shares: {
            some: {
              isActive: true,
              sharedWith: userId,
              OR: [
                { expiresAt: null },
                { expiresAt: { gt: new Date() } }
              ]
            }
          }
        }
      ],
      workflowStatus: { not: WorkflowStatus.DRAFT }
    };
  }

  /**
   * Build search filters from options
   */
  private buildSearchFilters(options: SearchOptions) {
    const filters: any = {};

    if (options.filters?.documentType) {
      filters.documentType = options.filters.documentType;
    }

    if (options.filters?.category) {
      filters.category = options.filters.category;
    }

    if (options.filters?.securityLevel) {
      filters.securityLevel = { in: options.filters.securityLevel };
    }

    if (options.filters?.dateRange) {
      filters.createdAt = {
        gte: options.filters.dateRange.from,
        lte: options.filters.dateRange.to
      };
    }

    if (options.filters?.fileSize) {
      const sizeFilter: any = {};
      if (options.filters.fileSize.min) {
        sizeFilter.gte = BigInt(options.filters.fileSize.min);
      }
      if (options.filters.fileSize.max) {
        sizeFilter.lte = BigInt(options.filters.fileSize.max);
      }
      if (Object.keys(sizeFilter).length > 0) {
        filters.fileSize = sizeFilter;
      }
    }

    if (options.filters?.tags && options.filters.tags.length > 0) {
      filters.tags = { hasSome: options.filters.tags };
    }

    if (options.filters?.folderId) {
      filters.folderId = options.filters.folderId;
    }

    if (options.filters?.ownerId) {
      filters.ownerId = options.filters.ownerId;
    }

    return filters;
  }

  private buildIndexFilters(options: SearchOptions): string[] {
    const filters: string[] = [`allowedUserIds = "${options.userId}"`];

    if (options.filters?.ownerId) {
      filters.push(`ownerId = "${options.filters.ownerId}"`);
    }

    if (options.filters?.sharedWithMe) {
      filters.push(`ownerId != "${options.userId}"`);
    }

    if (options.filters?.documentType) {
      filters.push(`documentType = "${options.filters.documentType}"`);
    }

    if (options.filters?.category) {
      filters.push(`category = "${options.filters.category}"`);
    }

    if (options.filters?.securityLevel?.length) {
      const levels = options.filters.securityLevel
        .map(level => `"${level}"`)
        .join(', ');
      filters.push(`securityLevel IN [${levels}]`);
    }

    if (options.filters?.tags?.length) {
      const tags = options.filters.tags
        .map(tag => `"${tag}"`)
        .join(', ');
      filters.push(`tags IN [${tags}]`);
    }

    if (options.filters?.folderId) {
      filters.push(`folderId = "${options.filters.folderId}"`);
    }

    if (options.filters?.dateRange?.from) {
      filters.push(`createdAt >= ${JSON.stringify(options.filters.dateRange.from.toISOString())}`);
    }

    if (options.filters?.dateRange?.to) {
      filters.push(`createdAt <= ${JSON.stringify(options.filters.dateRange.to.toISOString())}`);
    }

    if (options.filters?.fileSize?.min) {
      filters.push(`fileSize >= ${options.filters.fileSize.min}`);
    }

    if (options.filters?.fileSize?.max) {
      filters.push(`fileSize <= ${options.filters.fileSize.max}`);
    }

    return filters;
  }

  private buildIndexSort(sortBy?: string, sortOrder?: string): string | null {
    if (!sortBy) {
      return null;
    }

    const order = sortOrder === 'asc' ? 'asc' : 'desc';

    switch (sortBy) {
      case 'date':
        return `createdAt:${order}`;
      case 'name':
        return `title:${order}`;
      case 'size':
        return `fileSize:${order}`;
      case 'relevance':
      default:
        return null;
    }
  }

  private buildIndexRecord(
    document: (Document & {
      owner: { id: string; firstName: string | null; lastName: string | null };
      folder?: { id: string; name: string; path: string } | null;
      shares: Array<Pick<DocumentShare, 'sharedWith' | 'isActive' | 'expiresAt'>>;
      signatures: Array<Pick<DocumentSignature, 'signerId'>>;
    })
  ): IndexedDocumentRecord {
    const tags = this.normalizeTags(document.tags);

    const allowedUserIds = new Set<string>();
    const signedUserIds = new Set<string>();

    allowedUserIds.add(document.ownerId);
    allowedUserIds.add(document.createdBy);

    document.shares.forEach((share) => {
      if (share.isActive && share.sharedWith) {
        allowedUserIds.add(share.sharedWith);
      }
    });

    document.signatures.forEach((signature) => {
      if (signature.signerId) {
        signedUserIds.add(signature.signerId);
        allowedUserIds.add(signature.signerId);
      }
    });

    const searchableContent = this.buildSearchableContent(document);

    return {
      id: document.id,
      title: document.title,
      description: document.description ?? '',
      fileName: document.fileName,
      ownerId: document.ownerId,
      createdBy: document.createdBy,
      folderId: document.folderId ?? null,
      documentType: document.documentType,
      category: document.category,
      practiceArea: document.practiceArea ?? null,
      securityLevel: document.securityLevel,
      tags,
      searchableText: searchableContent.slice(0, 8000),
      allowedUserIds: Array.from(allowedUserIds),
      signedUserIds: Array.from(signedUserIds),
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
      fileSize: Number(document.fileSize ?? 0),
    };
  }

  /**
   * Execute text search query
   */
  private async executeTextSearch(query: string, whereCondition: any, options: SearchOptions) {
    const searchTerms = this.preprocessQuery(query);

    // Build text search condition
    const textSearchCondition = {
      OR: [
        { fileName: { contains: query, mode: 'insensitive' } },
        { originalFileName: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
        { extractedText: { contains: query, mode: 'insensitive' } },
        { searchableContent: { contains: query, mode: 'insensitive' } },
        { tags: { hasSome: searchTerms } }
      ]
    };

    // Combine with other conditions
    const finalWhere = {
      AND: [whereCondition, textSearchCondition]
    };

    return prisma.document.findMany({
      where: finalWhere,
      include: {
        owner: {
          select: { id: true, firstName: true, lastName: true }
        },
        folder: {
          select: { id: true, name: true, path: true }
        }
      }
    });
  }

  /**
   * Calculate relevance scores for search results
   */
  private async calculateRelevanceScores(documents: any[], query: string): Promise<SearchResult[]> {
    const searchTerms = this.preprocessQuery(query);

    return documents.map(document => {
      let relevanceScore = 0;
      const matchedFields: string[] = [];
      const highlights: SearchResult['highlights'] = [];

      // Score filename matches (highest weight)
      const filenameScore = this.calculateFieldScore(document.fileName, searchTerms, 3.0);
      if (filenameScore > 0) {
        relevanceScore += filenameScore;
        matchedFields.push('fileName');
        highlights.push({
          field: 'fileName',
          snippet: this.generateHighlight(document.fileName, searchTerms),
          position: 0
        });
      }

      // Score description matches
      if (document.description) {
        const descriptionScore = this.calculateFieldScore(document.description, searchTerms, 2.0);
        if (descriptionScore > 0) {
          relevanceScore += descriptionScore;
          matchedFields.push('description');
          highlights.push({
            field: 'description',
            snippet: this.generateHighlight(document.description, searchTerms),
            position: 0
          });
        }
      }

      // Score content matches
      if (document.extractedText) {
        const contentScore = this.calculateFieldScore(document.extractedText, searchTerms, 1.0);
        if (contentScore > 0) {
          relevanceScore += contentScore;
          matchedFields.push('content');
          const excerpt = this.generateExcerpt(document.extractedText, searchTerms);
          highlights.push({
            field: 'content',
            snippet: excerpt,
            position: 0
          });
        }
      }

      // Score tag matches
      const tagMatches = document.tags.filter((tag: string) =>
        searchTerms.some(term => tag.toLowerCase().includes(term.toLowerCase()))
      );
      if (tagMatches.length > 0) {
        relevanceScore += tagMatches.length * 1.5;
        matchedFields.push('tags');
      }

      // Generate excerpt
      const excerpt = this.generateExcerpt(
        document.extractedText || document.description || document.fileName,
        searchTerms
      );

      return {
        document,
        relevanceScore,
        matchedFields,
        highlights,
        excerpt
      };
    });
  }

  /**
   * Calculate field-specific relevance score
   */
  private calculateFieldScore(fieldValue: string, searchTerms: string[], weight: number): number {
    if (!fieldValue) return 0;

    const text = fieldValue.toLowerCase();
    let score = 0;

    searchTerms.forEach(term => {
      const termLower = term.toLowerCase();
      const regex = new RegExp(`\\b${termLower}\\b`, 'gi');
      const matches = text.match(regex);
      if (matches) {
        // Exact word matches get higher score
        score += matches.length * weight;
      } else if (text.includes(termLower)) {
        // Partial matches get lower score
        score += 0.5 * weight;
      }
    });

    return score;
  }

  /**
   * Apply sorting to search results
   */
  private applySorting(results: SearchResult[], sortBy?: string, sortOrder?: string): SearchResult[] {
    const order = sortOrder === 'desc' ? -1 : 1;

    return results.sort((a, b) => {
      switch (sortBy) {
        case 'date':
          return (a.document.createdAt.getTime() - b.document.createdAt.getTime()) * order;
        case 'name':
          return a.document.fileName.localeCompare(b.document.fileName) * order;
        case 'size':
          return (Number(a.document.fileSize) - Number(b.document.fileSize)) * order;
        case 'relevance':
        default:
          return (b.relevanceScore - a.relevanceScore) * (order === 1 ? -1 : 1);
      }
    });
  }

  /**
   * Apply pagination
   */
  private applyPagination(results: SearchResult[], limit?: number, offset?: number): SearchResult[] {
    const start = offset || 0;
    const end = limit ? start + limit : undefined;
    return results.slice(start, end);
  }

  /**
   * Calculate facets for search results
   */
  private async calculateFacets(whereCondition: any) {
    // Get document type counts
    const documentTypes = await prisma.document.groupBy({
      by: ['documentType'],
      where: whereCondition,
      _count: { documentType: true }
    });

    // Get category counts
    const categories = await prisma.document.groupBy({
      by: ['category'],
      where: whereCondition,
      _count: { category: true }
    });

    // Get owner counts
    const owners = await prisma.document.findMany({
      where: whereCondition,
      select: {
        ownerId: true,
        owner: {
          select: { firstName: true, lastName: true }
        }
      }
    });

    const ownerCounts = owners.reduce((acc, doc) => {
      const key = doc.ownerId;
      if (!acc[key]) {
        acc[key] = {
          ownerId: key,
          ownerName: `${doc.owner.firstName} ${doc.owner.lastName}`,
          count: 0
        };
      }
      acc[key].count++;
      return acc;
    }, {} as Record<string, any>);

    // Get tag counts (simplified)
    const documents = await prisma.document.findMany({
      where: whereCondition,
      select: { tags: true }
    });

    const tagCounts: Record<string, number> = {};
    documents.forEach(doc => {
      if (doc.tags && Array.isArray(doc.tags)) {
        (doc.tags as string[]).forEach((tag: string) => {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        });
      }
    });

    return {
      documentTypes: documentTypes.map(dt => ({
        type: dt.documentType,
        count: dt._count.documentType
      })),
      categories: categories.map(c => ({
        category: c.category,
        count: c._count.category
      })),
      tags: Object.entries(tagCounts)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      owners: Object.values(ownerCounts).slice(0, 10)
    };
  }

  private async transformFacetDistribution(
    facetDistribution?: Record<string, Record<string, number>>
  ): Promise<SearchResponse['facets']> {
    const emptyFacets: SearchResponse['facets'] = {
      documentTypes: [],
      categories: [],
      tags: [],
      owners: [],
    };

    if (!facetDistribution) {
      return emptyFacets;
    }

    const documentTypes = Object.entries(facetDistribution.documentType ?? {}).map(([type, count]) => ({
      type: type as DocumentType,
      count,
    }));

    const categories = Object.entries(facetDistribution.category ?? {}).map(([category, count]) => ({
      category: category as DocumentCategory,
      count,
    }));

    const tags = Object.entries(facetDistribution.tags ?? {})
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const ownerFacet = facetDistribution.ownerId ?? {};
    const ownerIds = Object.keys(ownerFacet);
    let owners: SearchResponse['facets']['owners'] = [];

    if (ownerIds.length) {
      const ownerRecords = await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, firstName: true, lastName: true },
      });

      const ownerNameMap = new Map(
        ownerRecords.map((owner) => [owner.id, `${owner.firstName ?? ''} ${owner.lastName ?? ''}`.trim() || 'Unknown user'])
      );

      owners = ownerIds
        .map((id) => ({
          ownerId: id,
          ownerName: ownerNameMap.get(id) ?? 'Unknown user',
          count: ownerFacet[id],
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    }

    return {
      documentTypes,
      categories,
      tags,
      owners,
    };
  }

  /**
   * Helper methods for text processing
   */
  private preprocessQuery(query: string): string[] {
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 2)
      .slice(0, 10); // Limit to 10 terms
  }

  private buildSearchableContent(document: any): string {
    const normalizedTags = this.normalizeTags(document.tags);

    const parts = [
      document.fileName,
      document.originalFileName,
      document.description || '',
      document.extractedText || '',
      normalizedTags.join(' '),
      document.owner ? `${document.owner.firstName} ${document.owner.lastName}` : '',
      document.folder ? document.folder.name : ''
    ];

    return parts.filter(Boolean).join(' ').toLowerCase();
  }

  private normalizeTags(tags: unknown): string[] {
    if (!tags) {
      return [];
    }

    if (Array.isArray(tags)) {
      return tags.filter((tag): tag is string => typeof tag === 'string');
    }

    if (typeof tags === 'string') {
      try {
        const parsed = JSON.parse(tags);
        if (Array.isArray(parsed)) {
          return parsed.filter((tag): tag is string => typeof tag === 'string');
        }
      } catch {
        return tags.split(',').map(tag => tag.trim()).filter(Boolean);
      }
    }

    if (typeof tags === 'object') {
      try {
        return Object.values(tags as Record<string, unknown>)
          .filter((value): value is string => typeof value === 'string');
      } catch {
        return [];
      }
    }

    return [];
  }

  private async generateSearchVector(content: string): Promise<string> {
    // This would typically integrate with a vector search service
    // For now, return a simple hash of the content
    const crypto = require('crypto');
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private extractKeyTerms(content: string): string[] {
    const words = content.toLowerCase().match(/\b\w{3,}\b/g) || [];
    const frequency: Record<string, number> = {};

    words.forEach(word => {
      frequency[word] = (frequency[word] || 0) + 1;
    });

    return Object.entries(frequency)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([word]) => word);
  }

  private generateHighlight(text: string, searchTerms: string[]): string {
    let highlighted = text;
    searchTerms.forEach(term => {
      const regex = new RegExp(`(${term})`, 'gi');
      highlighted = highlighted.replace(regex, '<mark>$1</mark>');
    });
    return highlighted;
  }

  private generateExcerpt(text: string, searchTerms: string[], maxLength: number = 200): string {
    if (!text) return '';

    // Find the first occurrence of any search term
    let bestPosition = 0;
    let foundTerm = false;

    searchTerms.forEach(term => {
      const index = text.toLowerCase().indexOf(term.toLowerCase());
      if (index !== -1 && (!foundTerm || index < bestPosition)) {
        bestPosition = index;
        foundTerm = true;
      }
    });

    // Generate excerpt around the found term
    const startPosition = Math.max(0, bestPosition - maxLength / 2);
    const endPosition = Math.min(text.length, startPosition + maxLength);

    let excerpt = text.substring(startPosition, endPosition);

    // Add ellipsis if needed
    if (startPosition > 0) excerpt = '...' + excerpt;
    if (endPosition < text.length) excerpt = excerpt + '...';

    // Highlight search terms in excerpt
    return this.generateHighlight(excerpt, searchTerms);
  }

  private async generateSuggestions(query: string, limit: number = 10): Promise<string[]> {
    // This would typically use a more sophisticated suggestion algorithm
    // For now, return some basic legal document related suggestions
    const legalTerms = [
      'contract', 'agreement', 'liability', 'copyright', 'trademark',
      'litigation', 'settlement', 'arbitration', 'deposition', 'discovery',
      'plaintiff', 'defendant', 'jurisdiction', 'statute', 'regulation'
    ];

    return legalTerms
      .filter(term => term.includes(query.toLowerCase()))
      .slice(0, limit);
  }

  private async getDocumentBasedSuggestions(query: string, userId: string, limit: number): Promise<string[]> {
    // Get commonly used terms from user's documents
    const documents = await prisma.document.findMany({
      where: {
        ownerId: userId,
        fileName: { contains: query, mode: 'insensitive' }
      },
      select: { fileName: true },
      take: limit * 2
    });

    return documents
      .map(doc => doc.fileName)
      .filter(name => name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit);
  }

  private async updateIndexingStats(stats: IndexingStats): Promise<void> {
    // This would typically update a statistics table
    console.log('Indexing completed:', stats);
  }
}

export default new DocumentSearchService();
export {
  DocumentSearchService,
  SearchOptions,
  SearchResult,
  SearchResponse,
  IndexingStats
};