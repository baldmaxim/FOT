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

const app = express();

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
