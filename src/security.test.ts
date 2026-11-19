import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from './app';
import prisma from './prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config';

describe('Security, Authentication, and RBAC Audit Test Suite', () => {
  let adminToken: string;
  let assistantToken: string;
  let disabledAssistantToken: string;
  let testAssistantId: string;
  let disabledAssistantId: string;

  beforeAll(async () => {
    // 1. Ensure admin exists with strong password
    const adminPasswordHash = await bcrypt.hash('AdminPassword123!', 12);
    const admin = await prisma.user.upsert({
      where: { username: 'admin' },
      update: { passwordHash: adminPasswordHash, isActive: true },
      create: {
        username: 'admin',
        passwordHash: adminPasswordHash,
        name: 'System Admin',
        role: 'ADMIN',
        isActive: true,
      },
    });

    adminToken = jwt.sign(
      { id: admin.id, userId: admin.id, role: admin.role, username: admin.username },
      config.jwt.secret,
      { expiresIn: '1h' }
    );

    // 2. Create active test assistant
    const assistantHash = await bcrypt.hash('Assistant123!', 12);
    const assistant = await prisma.user.upsert({
      where: { username: 'test_assistant_sec' },
      update: { passwordHash: assistantHash, isActive: true },
      create: {
        username: 'test_assistant_sec',
        passwordHash: assistantHash,
        name: 'Active Assistant',
        role: 'ASSISTANT',
        isActive: true,
      },
    });
    testAssistantId = assistant.id;

    assistantToken = jwt.sign(
      { id: assistant.id, userId: assistant.id, role: assistant.role, username: assistant.username },
      config.jwt.secret,
      { expiresIn: '1h' }
    );

    // 3. Create disabled test assistant
    const disabled = await prisma.user.upsert({
      where: { username: 'disabled_assistant_sec' },
      update: { passwordHash: assistantHash, isActive: false },
      create: {
        username: 'disabled_assistant_sec',
        passwordHash: assistantHash,
        name: 'Disabled Assistant',
        role: 'ASSISTANT',
        isActive: false,
      },
    });
    disabledAssistantId = disabled.id;

    disabledAssistantToken = jwt.sign(
      { id: disabled.id, userId: disabled.id, role: disabled.role, username: disabled.username },
      config.jwt.secret,
      { expiresIn: '1h' }
    );
  });

  afterAll(async () => {
    // Cleanup created test users
    await prisma.user.deleteMany({
      where: {
        username: { in: ['test_assistant_sec', 'disabled_assistant_sec'] },
      },
    });
    await prisma.$disconnect();
  });

  // =========================================================================
  // 1. Unauthenticated Access Lockdown (Zero Public Access)
  // =========================================================================
  describe('Unauthenticated Access Lockdown', () => {
    const protectedEndpoints = [
      { method: 'get', path: '/api/auth/me' },
      { method: 'get', path: '/api/users' },
      { method: 'get', path: '/api/students' },
      { method: 'get', path: '/api/subjects' },
      { method: 'get', path: '/api/fees?levelId=00000000-0000-0000-0000-000000000000' },
      { method: 'get', path: '/api/attendance/lesson?levelId=1&date=2026-01-01' },
      { method: 'get', path: '/api/billing/unconfirmed' },
      { method: 'get', path: '/api/charges' },
      { method: 'get', path: '/api/payments' },
      { method: 'get', path: '/api/reports/debtors' },
      { method: 'get', path: '/api/dashboard' },
      { method: 'get', path: '/api/settings' },
    ];

    it.each(protectedEndpoints)(
      'rejects unauthenticated $method $path with 401 UNAUTHORIZED',
      async ({ method, path }) => {
        const res = await (request(app) as any)[method](path);
        expect(res.status).toBe(401);
        expect(res.body.error?.code).toBe('UNAUTHORIZED');
      }
    );

    it('rejects malformed or invalid Bearer tokens with 401', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid-token-string');
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
    });

    it('rejects authorization header without Bearer prefix', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Basic 123456');
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
    });
  });

  // =========================================================================
  // 2. Backdoor Removal & Strong Password Enforcement
  // =========================================================================
  describe('Backdoor Removal & Password Security', () => {
    it('blocks login with previous fallback backdoor password "admin"', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin' });
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('INVALID_CREDENTIALS');
    });

    it('successfully logs in with legitimate bcrypt-hashed password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'AdminPassword123!' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body.user.role).toBe('ADMIN');
    });
  });

  // =========================================================================
  // 3. Disabled Account Invalidation
  // =========================================================================
  describe('Disabled Account Invalidation', () => {
    it('blocks disabled user from logging in with 403 ACCOUNT_DISABLED', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'disabled_assistant_sec', password: 'Assistant123!' });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('ACCOUNT_DISABLED');
    });

    it('immediately rejects existing token of disabled account on subsequent requests', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${disabledAssistantToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
      expect(res.body.error?.message).toContain('inactive');
    });
  });

  // =========================================================================
  // 4. Strict RBAC Enforcement (Assistant Privilege Escalation Prevention)
  // =========================================================================
  describe('Strict RBAC Enforcement (PERM-01 to PERM-17)', () => {
    it('blocks Assistant from user management (GET /api/users) with 403', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${assistantToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from creating users (POST /api/users) with 403', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${assistantToken}`)
        .send({ username: 'hacker', password: 'password123', name: 'Hacker' });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from creating subjects (POST /api/subjects) with 403', async () => {
      const res = await request(app)
        .post('/api/subjects')
        .set('Authorization', `Bearer ${assistantToken}`)
        .send({ name: 'Unauthorized Subject' });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from deleting subjects (DELETE /api/subjects/:id) with 403', async () => {
      const res = await request(app)
        .delete('/api/subjects/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${assistantToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from setting fees (POST /api/fees) with 403', async () => {
      const res = await request(app)
        .post('/api/fees')
        .set('Authorization', `Bearer ${assistantToken}`)
        .send({
          levelId: '00000000-0000-0000-0000-000000000000',
          month: '2026-05',
          subscriptionFee: 100,
          perLessonFee: 20,
        });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from updating business settings (PATCH /api/settings) with 403', async () => {
      const res = await request(app)
        .patch('/api/settings')
        .set('Authorization', `Bearer ${assistantToken}`)
        .send({ businessName: 'Hacked Center' });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from editing student info (PATCH /api/students/:id) with 403', async () => {
      const res = await request(app)
        .patch('/api/students/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${assistantToken}`)
        .send({ fullName: 'Edited Student' });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from deleting students (DELETE /api/students/:id) with 403', async () => {
      const res = await request(app)
        .delete('/api/students/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${assistantToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from waiving charges (POST /api/charges/:id/waive) with 403', async () => {
      const res = await request(app)
        .post('/api/charges/00000000-0000-0000-0000-000000000000/waive')
        .set('Authorization', `Bearer ${assistantToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from voiding payment groups (POST /api/payments/:id/void) with 403', async () => {
      const res = await request(app)
        .post('/api/payments/00000000-0000-0000-0000-000000000000/void')
        .set('Authorization', `Bearer ${assistantToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from viewing debtors list (GET /api/reports/debtors) with 403', async () => {
      const res = await request(app)
        .get('/api/reports/debtors')
        .set('Authorization', `Bearer ${assistantToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from viewing financial summary (GET /api/reports/financial) with 403', async () => {
      const res = await request(app)
        .get('/api/reports/financial')
        .set('Authorization', `Bearer ${assistantToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from viewing unconfirmed billing report with 403', async () => {
      const res = await request(app)
        .get('/api/reports/unconfirmed')
        .set('Authorization', `Bearer ${assistantToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from viewing all business charges without studentId with 403', async () => {
      const res = await request(app)
        .get('/api/charges')
        .set('Authorization', `Bearer ${assistantToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });

    it('blocks Assistant from viewing all business payments without studentId with 403', async () => {
      const res = await request(app)
        .get('/api/payments')
        .set('Authorization', `Bearer ${assistantToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    });
  });

  // =========================================================================
  // 5. Security Headers, CORS, and 404 JSON Catch-All
  // =========================================================================
  describe('API Hardening & Error Handling', () => {
    it('sets security headers (Helmet)', async () => {
      const res = await request(app).get('/');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers).toHaveProperty('x-dns-prefetch-control');
    });

    it('returns clean JSON 404 for unknown endpoints without stack trace', async () => {
      const res = await request(app).get('/api/unknown/random/endpoint');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'API endpoint not found',
        },
      });
      expect(res.body).not.toHaveProperty('stack');
    });
  });
});
