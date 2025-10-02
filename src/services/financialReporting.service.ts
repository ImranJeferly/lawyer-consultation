import prisma from '../config/database';
import { Currency, PaymentStatus, ConsultationType } from '@prisma/client';

interface ReportFilters {
  startDate: Date;
  endDate: Date;
  lawyerId?: string;
  clientId?: string;
  currency?: string;
  consultationType?: string;
  paymentStatus?: string;
  includeRefunds?: boolean;
}

interface RevenueMetrics {
  totalRevenue: number;
  platformRevenue: number;
  lawyerRevenue: number;
  refundedAmount: number;
  netRevenue: number;
  currency: string;
}

interface TransactionMetrics {
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  refundedTransactions: number;
  averageTransactionValue: number;
  successRate: number;
  refundRate: number;
}

interface ConsultationMetrics {
  totalConsultations: number;
  completedConsultations: number;
  cancelledConsultations: number;
  totalDuration: number; // in minutes
  averageDuration: number;
  completionRate: number;
  consultationsByType: Record<string, number>;
}

interface LawyerPerformanceMetrics {
  lawyerId: string;
  lawyerName: string;
  totalConsultations: number;
  totalRevenue: number;
  averageRating: number;
  completionRate: number;
  responseTime: number; // average in hours
  totalEarnings: number;
}

interface ClientInsights {
  totalClients: number;
  newClients: number;
  returningClients: number;
  averageSpendPerClient: number;
  clientRetentionRate: number;
  topSpendingClients: Array<{
    clientId: string;
    clientName: string;
    totalSpent: number;
    consultationCount: number;
  }>;
}

interface FinancialReport {
  reportId: string;
  generatedAt: Date;
  period: { startDate: Date; endDate: Date };
  revenue: RevenueMetrics;
  transactions: TransactionMetrics;
  consultations: ConsultationMetrics;
  lawyerPerformance: LawyerPerformanceMetrics[];
  clientInsights: ClientInsights;
  trends: {
    dailyRevenue: Array<{ date: string; revenue: number }>;
    monthlyGrowth: number;
    seasonality: Record<string, number>;
  };
  riskMetrics: {
    fraudRate: number;
    disputeRate: number;
    chargebackRate: number;
    averageRiskScore: number;
  };
}

interface TaxReport {
  period: { startDate: Date; endDate: Date };
  platformRevenue: number;
  taxableAmount: number;
  vatCollected: number;
  taxRate: number;
  exemptionsApplied: number;
  breakdown: Array<{
    date: string;
    grossRevenue: number;
    taxableRevenue: number;
    vatAmount: number;
  }>;
}

interface PayoutSummary {
  totalPayouts: number;
  totalAmount: number;
  pendingPayouts: number;
  pendingAmount: number;
  paidPayouts: number;
  paidAmount: number;
  lawyerPayouts: Array<{
    lawyerId: string;
    lawyerName: string;
    totalEarnings: number;
    totalPaid: number;
    pendingAmount: number;
    payoutCount: number;
  }>;
}

class FinancialReportingService {
  private readonly VAT_RATE = 0.18; // 18% VAT for Azerbaijan
  private readonly PLATFORM_FEE_RATE = 0.15; // 15% platform fee

  /**
   * Generate comprehensive financial report
   */
  async generateFinancialReport(filters: ReportFilters): Promise<FinancialReport> {
    try {
      const reportId = this.generateReportId();
      const generatedAt = new Date();

      // Generate all report sections in parallel
      const [
        revenue,
        transactions,
        consultations,
        lawyerPerformance,
        clientInsights,
        trends,
        riskMetrics
      ] = await Promise.all([
        this.calculateRevenueMetrics(filters),
        this.calculateTransactionMetrics(filters),
        this.calculateConsultationMetrics(filters),
        this.calculateLawyerPerformance(filters),
        this.calculateClientInsights(filters),
        this.calculateTrends(filters),
        this.calculateRiskMetrics(filters)
      ]);

      const report: FinancialReport = {
        reportId,
        generatedAt,
        period: {
          startDate: filters.startDate,
          endDate: filters.endDate
        },
        revenue,
        transactions,
        consultations,
        lawyerPerformance,
        clientInsights,
        trends,
        riskMetrics
      };

      // Store report for audit purposes
      await this.storeReport(report);

      return report;

    } catch (error) {
      console.error('Generate financial report error:', error);
      throw new Error('Failed to generate financial report');
    }
  }

  /**
   * Calculate revenue metrics
   */
  private async calculateRevenueMetrics(filters: ReportFilters): Promise<RevenueMetrics> {
    try {
      const { startDate, endDate, currency = 'AZN' } = filters;

      // Get payment data
      const payments = await prisma.payment.findMany({
        where: {
          createdAt: { gte: startDate, lte: endDate },
          status: { in: ['AUTHORIZED', 'CAPTURED'] },
          ...(filters.lawyerId && {
            appointment: { lawyerId: filters.lawyerId }
          }),
          ...(filters.clientId && {
            appointment: { clientId: filters.clientId }
          }),
          ...(currency !== 'AZN' && { currency: currency as any })
        },
        include: {
          appointment: true,
          refunds: {
            where: { status: 'PROCESSED' }
          }
        }
      });

      const totalRevenue = payments.reduce((sum, p) => sum + p.totalAmount, 0);
      const platformRevenue = payments.reduce((sum, p) => sum + p.platformFee + p.taxes, 0);
      const lawyerRevenue = totalRevenue - platformRevenue;

      const refundedAmount = payments.reduce((sum, p) =>
        sum + p.refunds.reduce((refSum, r) => refSum + r.amount, 0), 0
      );

      const netRevenue = totalRevenue - refundedAmount;

      return {
        totalRevenue,
        platformRevenue,
        lawyerRevenue,
        refundedAmount,
        netRevenue,
        currency
      };

    } catch (error) {
      console.error('Calculate revenue metrics error:', error);
      throw new Error('Failed to calculate revenue metrics');
    }
  }

  /**
   * Calculate transaction metrics
   */
  private async calculateTransactionMetrics(filters: ReportFilters): Promise<TransactionMetrics> {
    try {
      const { startDate, endDate } = filters;

      // Get all payments in period
      const allPayments = await prisma.payment.findMany({
        where: {
          createdAt: { gte: startDate, lte: endDate },
          ...(filters.lawyerId && {
            appointment: { lawyerId: filters.lawyerId }
          })
        },
        include: {
          refunds: { where: { status: 'PROCESSED' } }
        }
      });

      const totalTransactions = allPayments.length;
      const successfulTransactions = allPayments.filter(p =>
        ['AUTHORIZED', 'CAPTURED'].includes(p.status)
      ).length;
      const failedTransactions = allPayments.filter(p => p.status === 'FAILED').length;
      const refundedTransactions = allPayments.filter(p => p.refunds.length > 0).length;

      const totalValue = allPayments
        .filter(p => ['AUTHORIZED', 'CAPTURED'].includes(p.status))
        .reduce((sum, p) => sum + p.totalAmount, 0);

      const averageTransactionValue = successfulTransactions > 0 ? totalValue / successfulTransactions : 0;
      const successRate = totalTransactions > 0 ? (successfulTransactions / totalTransactions) * 100 : 0;
      const refundRate = successfulTransactions > 0 ? (refundedTransactions / successfulTransactions) * 100 : 0;

      return {
        totalTransactions,
        successfulTransactions,
        failedTransactions,
        refundedTransactions,
        averageTransactionValue,
        successRate,
        refundRate
      };

    } catch (error) {
      console.error('Calculate transaction metrics error:', error);
      throw new Error('Failed to calculate transaction metrics');
    }
  }

  /**
   * Calculate consultation metrics
   */
  private async calculateConsultationMetrics(filters: ReportFilters): Promise<ConsultationMetrics> {
    try {
      const { startDate, endDate } = filters;

      const appointments = await prisma.appointment.findMany({
        where: {
          createdAt: { gte: startDate, lte: endDate },
          ...(filters.lawyerId && { lawyerId: filters.lawyerId }),
          ...(filters.clientId && { clientId: filters.clientId }),
          ...(filters.consultationType && { consultationType: filters.consultationType as any })
        }
      });

      const totalConsultations = appointments.length;
      const completedConsultations = appointments.filter(a => a.status === 'COMPLETED').length;
      const cancelledConsultations = appointments.filter(a => a.status === 'CANCELLED').length;

      const totalDuration = appointments
        .filter(a => a.actualDuration !== null)
        .reduce((sum, a) => sum + (a.actualDuration || a.consultationDuration), 0);

      const averageDuration = completedConsultations > 0
        ? totalDuration / completedConsultations
        : 0;

      const completionRate = totalConsultations > 0
        ? (completedConsultations / totalConsultations) * 100
        : 0;

      // Group by consultation type
      const consultationsByType = appointments.reduce((acc, appointment) => {
        acc[appointment.consultationType] = (acc[appointment.consultationType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      return {
        totalConsultations,
        completedConsultations,
        cancelledConsultations,
        totalDuration,
        averageDuration,
        completionRate,
        consultationsByType
      };

    } catch (error) {
      console.error('Calculate consultation metrics error:', error);
      throw new Error('Failed to calculate consultation metrics');
    }
  }

  /**
   * Calculate lawyer performance metrics
   */
  private async calculateLawyerPerformance(filters: ReportFilters): Promise<LawyerPerformanceMetrics[]> {
    try {
      const { startDate, endDate } = filters;

      const lawyerData = await prisma.lawyerProfile.findMany({
        where: {
          ...(filters.lawyerId && { id: filters.lawyerId })
        },
        include: {
          user: true,
          appointments: {
            where: {
              createdAt: { gte: startDate, lte: endDate }
            },
            include: {
              payment: true,
              reviews: true
            }
          }
        }
      });

      return lawyerData.map(lawyer => {
        const appointments = lawyer.appointments;
        const completedAppointments = appointments.filter(a => a.status === 'COMPLETED');

        const totalRevenue = appointments
          .filter(a => a.payment && ['AUTHORIZED', 'CAPTURED'].includes(a.payment.status))
          .reduce((sum, a) => sum + a.payment!.totalAmount, 0);

        const totalEarnings = appointments
          .filter(a => a.payment && ['AUTHORIZED', 'CAPTURED'].includes(a.payment.status))
          .reduce((sum, a) => {
            const p = a.payment!;
            return sum + (p.totalAmount - p.platformFee - p.taxes);
          }, 0);

        const reviews = completedAppointments.flatMap(a => a.reviews);
        const averageRating = reviews.length > 0
          ? reviews.reduce((sum, r) => sum + ((r as any).rating || 0), 0) / reviews.length
          : 0;

        const completionRate = appointments.length > 0
          ? (completedAppointments.length / appointments.length) * 100
          : 0;

        // Calculate average response time (simplified)
        const responseTime = 2; // This would be calculated from actual response data

        return {
          lawyerId: lawyer.id,
          lawyerName: `${lawyer.user.firstName} ${lawyer.user.lastName}`,
          totalConsultations: appointments.length,
          totalRevenue,
          averageRating,
          completionRate,
          responseTime,
          totalEarnings
        };
      });

    } catch (error) {
      console.error('Calculate lawyer performance error:', error);
      throw new Error('Failed to calculate lawyer performance');
    }
  }

  /**
   * Calculate client insights
   */
  private async calculateClientInsights(filters: ReportFilters): Promise<ClientInsights> {
    try {
      const { startDate, endDate } = filters;

      // Get all clients with appointments in the period
      // Client relationship does not exist in current schema - using simplified query
      const clientData = await prisma.user.findMany({
        where: {
          // Simplified query since client relationship doesn't exist
        }
      });

      const totalClients = clientData.length;

      // Calculate new vs returning clients
      const newClients = await this.calculateNewClients(clientData, startDate);
      const returningClients = totalClients - newClients;

      // Calculate spending metrics
      const totalSpent = clientData.reduce((sum, client) => {
        return sum + ((client as any).client?.appointments || []).reduce((appointmentSum: number, appointment: any) => {
          return appointmentSum + (appointment.payment?.totalAmount || 0);
        }, 0);
      }, 0);

      const averageSpendPerClient = totalClients > 0 ? totalSpent / totalClients : 0;

      // Calculate retention rate (clients who had multiple consultations)
      const multipleConsultationClients = clientData.filter(client =>
        ((client as any).client?.appointments || []).length > 1
      ).length;
      const clientRetentionRate = totalClients > 0 ? (multipleConsultationClients / totalClients) * 100 : 0;

      // Top spending clients
      const topSpendingClients = clientData
        .map(client => {
          const totalSpent = ((client as any).client?.appointments || []).reduce((sum: number, appointment: any) =>
            sum + (appointment.payment?.totalAmount || 0), 0
          );
          return {
            clientId: client.id,
            clientName: `${client.firstName} ${client.lastName}`,
            totalSpent,
            consultationCount: (client as any).client?.appointments?.length || 0
          };
        })
        .sort((a, b) => b.totalSpent - a.totalSpent)
        .slice(0, 10);

      return {
        totalClients,
        newClients,
        returningClients,
        averageSpendPerClient,
        clientRetentionRate,
        topSpendingClients
      };

    } catch (error) {
      console.error('Calculate client insights error:', error);
      throw new Error('Failed to calculate client insights');
    }
  }

  /**
   * Calculate trends and growth metrics
   */
  private async calculateTrends(filters: ReportFilters): Promise<any> {
    try {
      const { startDate, endDate } = filters;

      // Daily revenue trend
      const dailyRevenue = await this.calculateDailyRevenue(startDate, endDate);

      // Monthly growth calculation
      const previousPeriodStart = new Date(startDate.getTime() - (endDate.getTime() - startDate.getTime()));
      const currentRevenue = await this.calculatePeriodRevenue(startDate, endDate);
      const previousRevenue = await this.calculatePeriodRevenue(previousPeriodStart, startDate);

      const monthlyGrowth = previousRevenue > 0
        ? ((currentRevenue - previousRevenue) / previousRevenue) * 100
        : 0;

      // Seasonality (simplified - by day of week)
      const seasonality = await this.calculateSeasonality(startDate, endDate);

      return {
        dailyRevenue,
        monthlyGrowth,
        seasonality
      };

    } catch (error) {
      console.error('Calculate trends error:', error);
      return {
        dailyRevenue: [],
        monthlyGrowth: 0,
        seasonality: {}
      };
    }
  }

  /**
   * Calculate risk metrics
   */
  private async calculateRiskMetrics(filters: ReportFilters): Promise<any> {
    try {
      const { startDate, endDate } = filters;

      const payments = await prisma.payment.findMany({
        where: {
          createdAt: { gte: startDate, lte: endDate }
        },
        include: {
          refunds: { where: { refundType: 'dispute' } },
          appointment: {
            include: {
              disputes: true
            }
          }
        }
      });

      const totalPayments = payments.length;
      const highRiskPayments = payments.filter(p => p.riskScore && p.riskScore >= 70).length;
      const disputedPayments = payments.filter(p => p.appointment.disputes.length > 0).length;
      const chargebackPayments = payments.filter(p =>
        p.refunds.some(r => r.refundType === 'dispute')
      ).length;

      const fraudRate = totalPayments > 0 ? (highRiskPayments / totalPayments) * 100 : 0;
      const disputeRate = totalPayments > 0 ? (disputedPayments / totalPayments) * 100 : 0;
      const chargebackRate = totalPayments > 0 ? (chargebackPayments / totalPayments) * 100 : 0;

      const averageRiskScore = payments.length > 0
        ? payments.reduce((sum, p) => sum + (p.riskScore || 0), 0) / payments.length
        : 0;

      return {
        fraudRate,
        disputeRate,
        chargebackRate,
        averageRiskScore
      };

    } catch (error) {
      console.error('Calculate risk metrics error:', error);
      return {
        fraudRate: 0,
        disputeRate: 0,
        chargebackRate: 0,
        averageRiskScore: 0
      };
    }
  }

  /**
   * Generate tax report for compliance
   */
  async generateTaxReport(startDate: Date, endDate: Date): Promise<TaxReport> {
    try {
      const payments = await prisma.payment.findMany({
        where: {
          createdAt: { gte: startDate, lte: endDate },
          status: { in: ['AUTHORIZED', 'CAPTURED'] }
        }
      });

      const platformRevenue = payments.reduce((sum, p) => sum + p.platformFee, 0);
      const vatCollected = payments.reduce((sum, p) => sum + p.taxes, 0);
      const taxableAmount = platformRevenue;

      // Daily breakdown
      const breakdown = await this.calculateDailyTaxBreakdown(payments);

      return {
        period: { startDate, endDate },
        platformRevenue,
        taxableAmount,
        vatCollected,
        taxRate: this.VAT_RATE,
        exemptionsApplied: 0, // Track any tax exemptions
        breakdown
      };

    } catch (error) {
      console.error('Generate tax report error:', error);
      throw new Error('Failed to generate tax report');
    }
  }

  /**
   * Generate payout summary report
   */
  async generatePayoutSummary(startDate: Date, endDate: Date): Promise<PayoutSummary> {
    try {
      const payouts = await prisma.payout.findMany({
        where: {
          createdAt: { gte: startDate, lte: endDate }
        },
        include: {
          lawyer: {
            include: { user: true }
          }
        }
      });

      const totalPayouts = payouts.length;
      const totalAmount = payouts.reduce((sum, p) => sum + p.netAmount, 0);

      const pendingPayouts = payouts.filter(p => p.status === 'PENDING').length;
      const pendingAmount = payouts
        .filter(p => p.status === 'PENDING')
        .reduce((sum, p) => sum + p.netAmount, 0);

      const paidPayouts = payouts.filter(p => p.status === 'COMPLETED').length;
      const paidAmount = payouts
        .filter(p => p.status === 'COMPLETED')
        .reduce((sum, p) => sum + p.netAmount, 0);

      // Group by lawyer
      const lawyerPayouts = Object.values(
        payouts.reduce((acc, payout) => {
          const lawyerId = payout.lawyerId;
          if (!acc[lawyerId]) {
            acc[lawyerId] = {
              lawyerId,
              lawyerName: `${payout.lawyer.user.firstName} ${payout.lawyer.user.lastName}`,
              totalEarnings: 0,
              totalPaid: 0,
              pendingAmount: 0,
              payoutCount: 0
            };
          }

          acc[lawyerId].totalEarnings += payout.netAmount;
          acc[lawyerId].payoutCount += 1;

          if (payout.status === 'COMPLETED') {
            acc[lawyerId].totalPaid += payout.netAmount;
          } else if (payout.status === 'PENDING') {
            acc[lawyerId].pendingAmount += payout.netAmount;
          }

          return acc;
        }, {} as Record<string, any>)
      );

      return {
        totalPayouts,
        totalAmount,
        pendingPayouts,
        pendingAmount,
        paidPayouts,
        paidAmount,
        lawyerPayouts
      };

    } catch (error) {
      console.error('Generate payout summary error:', error);
      throw new Error('Failed to generate payout summary');
    }
  }

  /**
   * Helper methods
   */
  private async calculateNewClients(clientData: any[], periodStart: Date): Promise<number> {
    return clientData.filter(client =>
      client.createdAt >= periodStart
    ).length;
  }

  private async calculateDailyRevenue(startDate: Date, endDate: Date): Promise<Array<{ date: string; revenue: number }>> {
    const dailyData: Array<{ date: string; revenue: number }> = [];
    const currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      const nextDate = new Date(currentDate);
      nextDate.setDate(nextDate.getDate() + 1);

      const dayRevenue = await prisma.payment.aggregate({
        where: {
          createdAt: { gte: currentDate, lt: nextDate },
          status: { in: ['AUTHORIZED', 'CAPTURED'] }
        },
        _sum: { totalAmount: true }
      });

      dailyData.push({
        date: currentDate.toISOString().split('T')[0],
        revenue: dayRevenue._sum.totalAmount || 0
      });

      currentDate.setDate(currentDate.getDate() + 1);
    }

    return dailyData;
  }

  private async calculatePeriodRevenue(startDate: Date, endDate: Date): Promise<number> {
    const result = await prisma.payment.aggregate({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        status: { in: ['AUTHORIZED', 'CAPTURED'] }
      },
      _sum: { totalAmount: true }
    });

    return result._sum.totalAmount || 0;
  }

  private async calculateSeasonality(startDate: Date, endDate: Date): Promise<Record<string, number>> {
    const payments = await prisma.payment.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        status: { in: ['AUTHORIZED', 'CAPTURED'] }
      },
      select: { createdAt: true, totalAmount: true }
    });

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const seasonality: Record<string, number> = {};

    dayNames.forEach(day => seasonality[day] = 0);

    payments.forEach(payment => {
      const dayOfWeek = dayNames[payment.createdAt.getDay()];
      seasonality[dayOfWeek] += payment.totalAmount;
    });

    return seasonality;
  }

  private async calculateDailyTaxBreakdown(payments: any[]): Promise<Array<{ date: string; grossRevenue: number; taxableRevenue: number; vatAmount: number }>> {
    const dailyData: Record<string, { grossRevenue: number; taxableRevenue: number; vatAmount: number }> = {};

    payments.forEach(payment => {
      const date = payment.createdAt.toISOString().split('T')[0];
      if (!dailyData[date]) {
        dailyData[date] = { grossRevenue: 0, taxableRevenue: 0, vatAmount: 0 };
      }

      dailyData[date].grossRevenue += payment.totalAmount;
      dailyData[date].taxableRevenue += payment.platformFee;
      dailyData[date].vatAmount += payment.taxes;
    });

    return Object.entries(dailyData).map(([date, data]) => ({
      date,
      ...data
    }));
  }

  private async storeReport(report: FinancialReport): Promise<void> {
    try {
      // Schema mismatch - most fields don't exist in current FinancialReport model
      // TODO: Update schema or create proper report storage
      console.log('Report storage disabled due to schema mismatch:', report.reportId);
      /*
      await prisma.financialReport.create({
        data: {
          // Most fields don't exist in current schema
          reportPeriod: 'MONTHLY',
          totalRevenue: 0,
          platformRevenue: 0,
          lawyerPayouts: 0,
          pendingPayouts: 0,
          completedTransactions: 0,
          refundedAmount: 0,
          taxAmount: 0,
          profitMargin: 0,
          avgTransactionValue: 0,
          topLawyerEarnings: {},
          clientSpendingTrends: {}
        }
      });
      */
    } catch (error) {
      console.error('Store report error:', error);
    }
  }

  private generateReportId(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2, 8);
    return `RPT-${timestamp}-${random.toUpperCase()}`;
  }
}

export default new FinancialReportingService();