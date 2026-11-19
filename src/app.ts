import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { errorHandler, AppError } from './middleware/errorHandler';

// Route imports
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import studentRoutes from './routes/students';
import subjectRoutes from './routes/subjects';
import feeRoutes from './routes/fees';
import attendanceRoutes from './routes/attendance';
import billingRoutes from './routes/billing';
import chargeRoutes from './routes/charges';
import paymentRoutes from './routes/payments';
import reportRoutes from './routes/reports';
import dashboardRoutes from './routes/dashboard';
import settingRoutes from './routes/settings';

const app = express();

// Security Headers (NFR-05)
app.use(helmet());

// CORS Configuration - Restrict to allowed origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }
      return callback(new AppError(403, 'CORS_ERROR', 'Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json());

// Root endpoint for status / info
app.get('/', (_req, res) => {
  res.json({
    status: 'online',
    name: 'Student Management System API',
    version: '1.0.0',
    endpoints: '/api',
    frontendUrl: 'http://localhost:3000',
    message: 'Backend API is running. Access the user interface at http://localhost:3000',
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/subjects', subjectRoutes);
app.use('/api/fees', feeRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/charges', chargeRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingRoutes);

// 404 Catch-All handler for unmatched routes
app.use((_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'API endpoint not found'));
});

// Error handler (must be last)
app.use(errorHandler);

export default app;
