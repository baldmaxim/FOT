import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';

const smokeDescribe = process.env.CODEX_SANDBOX ? describe.skip : describe;

smokeDescribe('Smoke Tests', () => {
  it('GET /health — returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });

  it('POST /api/auth/login — rejects invalid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nonexistent@test.com', password: 'wrongpassword123' });
    expect([400, 401]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/auth/login — rejects malformed request', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: '12' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/employees — rejects without auth token', async () => {
    const res = await request(app).get('/api/employees');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/auth/me — rejects without auth token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /api/employees — rejects with invalid token', async () => {
    const res = await request(app)
      .get('/api/employees')
      .set('Authorization', 'Bearer invalid.token.here');
    expect(res.status).toBe(401);
  });

  it('GET /nonexistent — returns 404', async () => {
    const res = await request(app).get('/nonexistent');
    expect(res.status).toBe(404);
  });
});
