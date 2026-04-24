import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { corsAllowedOrigins } from './config/env.js';
import { apiLimiter } from './middleware/rateLimit.js';

// Routes
import authRoutes from './routes/auth.routes.js';
import employeesRoutes from './routes/employees.routes.js';
import adminRoutes from './routes/admin.routes.js';
import skudRoutes from './routes/skud.routes.js';
import structureRoutes from './routes/structure.routes.js';
import auditRoutes from './routes/audit.routes.js';
import sigurRoutes from './routes/sigur.routes.js';
import timesheetRoutes from './routes/timesheet.routes.js';
import chatRoutes from './routes/chat.routes.js';
import pushRoutes from './routes/push.routes.js';
import leaveRequestsRoutes from './routes/leave-requests.routes.js';
import officialMemosRoutes from './routes/official-memos.routes.js';
import documentsRoutes from './routes/documents.routes.js';
import payslipsRoutes from './routes/payslips.routes.js';
import paymentsRoutes from './routes/payments.routes.js';
import productionCalendarRoutes from './routes/production-calendar.routes.js';
import timesheetApprovalRoutes from './routes/timesheet-approval.routes.js';
import scheduleRoutes from './routes/schedule.routes.js';
import workCategoriesRoutes from './routes/work-categories.routes.js';
import rolesRoutes from './routes/roles.routes.js';
import salaryRaiseRoutes from './routes/salary-raise.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import notificationRoutes from './routes/notification.routes.js';

const app = express();

// Trust local reverse proxies so rate limiting uses the real client IP.
// Production traffic comes through rw-core -> nginx -> node on loopback.
app.set('trust proxy', 'loopback');

// Security middleware
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || corsAllowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS origin is not allowed: ${origin}`));
  },
  credentials: true,
  exposedHeaders: ['Content-Disposition'],
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use('/api', apiLimiter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/skud', skudRoutes);
app.use('/api/structure', structureRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/sigur', sigurRoutes);
app.use('/api/timesheet', timesheetRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/leave-requests', leaveRequestsRoutes);
app.use('/api/official-memos', officialMemosRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/payslips', payslipsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/production-calendar', productionCalendarRoutes);
app.use('/api/timesheet-approvals', timesheetApprovalRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/work-categories', workCategoriesRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/salary-raise', salaryRaiseRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/notifications', notificationRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

export default app;
