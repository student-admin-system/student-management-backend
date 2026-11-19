import express from 'express';
import cors from 'cors';
import { errorHandler } from './middleware/errorHandler';

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

// Middleware
app.use(cors());
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

// Error handler (must be last)
app.use(errorHandler);

export default app;
