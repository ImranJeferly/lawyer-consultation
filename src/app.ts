// Express app configuration without server startup
import express, { Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';

// Load environment variables
dotenv.config();

// Import routes
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import lawyerRoutes from './routes/lawyer.routes';
import adminRoutes from './routes/admin.routes';
// import bookingRoutes from './routes/booking.routes';
import paymentRoutes from './routes/payment.routes';
import payoutRoutes from './routes/payout.routes';
import communicationsRoutes from './routes/communications.routes.simple';
import notificationsRoutes from './routes/notifications.routes';
import documentsRoutes from './routes/documents.routes';
import searchRoutes from './routes/search.routes';
import discoveryRoutes from './routes/discovery.routes';
import monitoringRoutes from './routes/monitoring.routes';
import rateLimitRoutes from './routes/rateLimit.routes';
import securityRoutes from './routes/security.routes';
import loggingRoutes from './routes/logging.routes';
import analyticsRoutes from './routes/analytics.routes';

// Import WebSocket manager
import webSocketManager from './services/websocketManager.service';

// Import performance monitoring
import performanceMonitor from './middleware/performance.middleware';

// Import security middleware
import securityMiddleware, { corsOptions } from './middleware/security.middleware';

// Import error handling middleware
import errorHandler from './middleware/errorHandler.middleware';

// Import logging service
import loggingService, { LogCategory, LogLevel } from './services/logging.service';
import notificationQueueService from './services/notification-queue.service';
import { createRedisClient } from './config/redis';

// Import rate limiting middleware
import { 
  generalRateLimit,
  authRateLimit,
  paymentRateLimit,
  uploadRateLimit,
  searchRateLimit,
  bookingRateLimit,
  adminRateLimit
} from './middleware/rateLimiting.middleware';

const app = express();

// Create HTTP server
const httpServer = createServer(app);

// Initialize Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  }
});

const socketRedisPublisher = createRedisClient('socket-io-pub', { lazyConnect: true });
const socketRedisSubscriber = createRedisClient('socket-io-sub', { lazyConnect: true });

Promise.all([socketRedisPublisher.connect(), socketRedisSubscriber.connect()])
  .then(() => {
    io.adapter(createAdapter(socketRedisPublisher, socketRedisSubscriber));
    loggingService.log(LogLevel.INFO, LogCategory.SYSTEM, 'Socket.IO Redis adapter initialized');
  })
  .catch((error: Error) => {
    loggingService.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Failed to configure Socket.IO Redis adapter', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  });

// Middleware
app.use(securityMiddleware.securityHeaders); // Enhanced security headers
app.use(cors(corsOptions)); // Enhanced CORS with security
app.use(express.json({
  limit: '10mb',
  verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
  if (req.originalUrl.startsWith('/api/auth/webhook')) {
      req.rawBody = Buffer.from(buf);
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(securityMiddleware.sanitizeInput); // Input sanitization
app.use(securityMiddleware.preventSQLInjection); // SQL injection prevention
app.use(securityMiddleware.requestSizeLimit('10mb')); // Request size limiting
app.use(performanceMonitor.requestTimer); // Performance monitoring
app.use(generalRateLimit); // General rate limiting

// Enhanced logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const responseTime = Date.now() - startTime;
    loggingService.logRequest(req, res, responseTime);
  });
  
  next();
});

app.use(morgan('combined')); // HTTP request logger

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Routes with specific rate limiting
app.use('/api/auth', authRateLimit, authRoutes);
app.use('/api/mfa', authRateLimit, require('./routes/mfa.routes').default);
app.use('/api/users', userRoutes);
app.use('/api/lawyers', lawyerRoutes);
app.use('/api/admin', adminRateLimit, adminRoutes);
// app.use('/api/bookings', bookingRateLimit, bookingRoutes);
app.use('/api/payments', paymentRateLimit, paymentRoutes);
app.use('/api/payouts', paymentRateLimit, payoutRoutes);
app.use('/api/communications', communicationsRoutes);
// app.use('/api/notifications', notificationsRoutes);
app.use('/api/documents', uploadRateLimit, documentsRoutes);
app.use('/api/search', searchRateLimit, searchRoutes);
app.use('/api/discovery', discoveryRoutes);
app.use('/api/monitoring', monitoringRoutes);
app.use('/api/rate-limits', rateLimitRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/logging', loggingRoutes);
app.use('/api/analytics', generalRateLimit, analyticsRoutes);
app.use('/api/notifications', notificationsRoutes);

// Initialize WebSocket Manager for real-time communication
webSocketManager.initialize(io);

notificationQueueService.initialize().catch((error: Error) => {
  loggingService.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Failed to initialize notification queue', {
    error: error instanceof Error ? error.message : 'Unknown error'
  });
});

// Enhanced error handling middleware
app.use(errorHandler.handle404);
app.use(errorHandler.handleError);

export default app;
export { httpServer, io };