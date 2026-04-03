import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
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
import documentsRoutes from './routes/documents.routes.js';
import payslipsRoutes from './routes/payslips.routes.js';
import paymentsRoutes from './routes/payments.routes.js';
import timesheetApprovalRoutes from './routes/timesheet-approval.routes.js';
import scheduleRoutes from './routes/schedule.routes.js';
import rolesRoutes from './routes/roles.routes.js';

const app = express();

// Trust nginx proxy (needed for correct IP in rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());
app.use(cors({
  origin: env.CORS_ORIGIN,
  credentials: true,
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
app.use('/api/documents', documentsRoutes);
app.use('/api/payslips', payslipsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/timesheet-approvals', timesheetApprovalRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/roles', rolesRoutes);

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
