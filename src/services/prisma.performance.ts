import { PrismaClient } from '@prisma/client';
import performanceMonitor from '../middleware/performance.middleware';

// Simple performance wrapper for database queries
class DatabasePerformanceTracker {
  private prisma: PrismaClient;
  
  constructor() {
    this.prisma = new PrismaClient();
  }

  // Wrapper method for tracking query performance
  async trackQuery<T>(queryName: string, queryFn: () => Promise<T>): Promise<T> {
    const startTime = Date.now();
    
    try {
      const result = await queryFn();
      const duration = Date.now() - startTime;
      
      // Track the query performance
      performanceMonitor.trackDbQuery(queryName, duration);
      
      // Log slow queries (over 500ms)
      if (duration > 500) {
        console.warn(`🐌 Slow query detected: ${queryName} took ${duration}ms`);
      }
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      performanceMonitor.trackDbQuery(`${queryName} [ERROR]`, duration);
      throw error;
    }
  }

  // Get the underlying Prisma client
  getClient(): PrismaClient {
    return this.prisma;
  }

  // Close the database connection
  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

export const dbTracker = new DatabasePerformanceTracker();
export const prisma = dbTracker.getClient();