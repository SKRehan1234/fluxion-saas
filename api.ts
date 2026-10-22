import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import nodemailer from 'nodemailer';

let clientPromise: Promise<MongoClient> | undefined;
function database(env: NodeJS.ProcessEnv) {
  const uri = env.MONGODB_URL || 'mongodb://127.0.0.1:27017';
  if (!clientPromise) clientPromise = new MongoClient(uri).connect();
  return clientPromise.then(client => client.db(env.MONGODB_DB || 'fluxion'));
}
function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<any> {
  let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 1_000_000) throw new Error('Request too large'); }
  return data ? JSON.parse(data) : {};
}
function mailer(env: NodeJS.ProcessEnv) {
  const port = Number(env.SMTP_PORT || 587);
  if (!env.SMTP_USER || !env.SMTP_PASS) return null;
  return nodemailer.createTransport({host: env.SMTP_HOST || 'smtp.ethereal.email', port, secure: env.SMTP_SECURE === 'true', auth: {user: env.SMTP_USER, pass: env.SMTP_PASS}});
}
export function apiPlugin(env: NodeJS.ProcessEnv = process.env): Plugin {
  return { name: 'fluxion-api', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url || '').split('?')[0];
      if (!path?.startsWith('/api/')) return next();
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader('Access-Control-Allow-Origin', ''); return res.end(); }
      try {
        if (req.method !== 'POST') return sendJson(res, 405, {error: 'Method not allowed'});
        const body = await readBody(req);
        if (path === '/api/signup') {
          const name = String(body.name || '').trim(); const email = String(body.email || '').trim().toLowerCase();
          const plan = ['Starter', 'Pro', 'Enterprise'].includes(body.plan) ? body.plan : 'Starter';
          if (name.length < 2 || name.length > 80) return sendJson(res, 400, {error: 'Please enter a name between 2 and 80 characters.'});
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return sendJson(res, 400, {error: 'Please enter a valid email address.'});
          const db = await database(env); const users = db.collection('users');
          const existing = await users.findOne({email});
          if (existing) return sendJson(res, 409, {error: existing.verified ? 'An account with this email already exists. Please sign in.' : 'A verification email has already been requested for this email.'});
          const rawToken = randomBytes(32).toString('hex'); const tokenHash = createHash('sha256').update(rawToken).digest('hex');
          const user = {name, email, plan, verified: false, tokenHash, tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), createdAt: new Date(), notifications: true, onboarding: {profile: false, workspace: false, invite: false}};
          const { insertedId } = await users.insertOne(user);
          const url = `${env.APP_URL || 'http://localhost:5173'}/?verify=${rawToken}`;
          const transport = mailer(env);
          if (transport) {
            try { await transport.sendMail({from: env.SMTP_FROM || env.SMTP_USER, to: email, subject: 'Verify your Fluxion email', text: `Hi ${name},\n\nVerify your email using this link (valid for 24 hours):\n${url}\n\nIf you did not request this, you can ignore this email.`, html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px"><h1 style="color:#6558e8">Welcome to Fluxion, ${escapeHtml(name)}!</h1><p>One quick step before you get started. Confirm your email address below.</p><p><a href="${url}" style="display:inline-block;background:#6558e8;color:white;padding:13px 20px;border-radius:9px;text-decoration:none">Verify email address</a></p><p>This link expires in 24 hours. If you didn't request this, ignore this message.</p></div>`}); }
            catch { await users.deleteOne({_id: insertedId}); throw new Error('Email could not be sent. Check SMTP settings and try again.'); }
          } else {
            console.warn(`[Fluxion dev] SMTP not configured. Verification link for ${email}: ${url}`);
          }
          return sendJson(res, 201, {ok: true, message: 'Account created. Check your inbox for the verification link.', email, previewVerificationUrl: env.NODE_ENV !== 'production' && !transport ? url : undefined});
        }
        if (path === '/api/verify') {
          const token = String(body.token || ''); if (!/^[a-f0-9]{64}$/.test(token)) return sendJson(res, 400, {error: 'This verification link is invalid.'});
          const tokenHash = createHash('sha256').update(token).digest('hex'); const db = await database(env); const users = db.collection('users');
          const user = await users.findOne({tokenHash});
          if (!user) { const verified = await users.findOne({verifiedTokenHash: tokenHash}); return verified ? sendJson(res, 200, {ok: true, alreadyVerified: true, name: verified.name}) : sendJson(res, 400, {error: 'This link is invalid or has expired. Please sign up again.'}); }
          if (!user.tokenExpiresAt || user.tokenExpiresAt < new Date()) return sendJson(res, 400, {error: 'This verification link has expired. Please sign up again.'});
          await users.updateOne({_id: user._id}, {$set: {verified: true, verifiedAt: new Date(), verifiedTokenHash: tokenHash}, $unset: {tokenHash: '', tokenExpiresAt: ''}});
          return sendJson(res, 200, {ok: true, name: user.name});
        }
        if (path === '/api/lead') {
          const email = String(body.email || '').trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, {error: 'Enter a valid email address.'});
          const db = await database(env); await db.collection('leads').updateOne({email}, {$set: {email, updatedAt: new Date(), source: 'landing-page'}, $setOnInsert: {createdAt: new Date()}}, {upsert: true});
          return sendJson(res, 201, {ok: true, message: 'Thanks! You are on the list.'});
        }
        if (path === '/api/dashboard') {
          const email = String(body.email || '').trim().toLowerCase(); const db = await database(env);
          const user = await db.collection('users').findOne({email, verified: true}, {projection: {name: 1, email: 1, plan: 1, createdAt: 1, notifications: 1, onboarding: 1}});
          if (!user) return sendJson(res, 404, {error: 'Verified account not found. Please verify your email first.'});
          return sendJson(res, 200, {user: {...user, _id: String(user._id)}});
        }
        if (path === '/api/profile') {
          const email = String(body.email || '').trim().toLowerCase(); const name = String(body.name || '').trim(); const notifications = Boolean(body.notifications);
          if (name.length < 2 || name.length > 80) return sendJson(res, 400, {error: 'Name must be between 2 and 80 characters.'});
          const db = await database(env); const result = await db.collection('users').updateOne({email, verified: true}, {$set: {name, notifications, updatedAt: new Date()}});
          if (!result.matchedCount) return sendJson(res, 404, {error: 'Verified account not found.'});
          return sendJson(res, 200, {ok: true});
        }
        if (path === '/api/onboarding') {
          const email = String(body.email || '').trim().toLowerCase(); const key = String(body.key || '');
          if (!['profile', 'workspace', 'invite'].includes(key)) return sendJson(res, 400, {error: 'Invalid onboarding step.'});
          const db = await database(env); const result = await db.collection('users').updateOne({email, verified: true}, {$set: {[`onboarding.${key}`]: Boolean(body.done)}});
          if (!result.matchedCount) return sendJson(res, 404, {error: 'Verified account not found.'});
          return sendJson(res, 200, {ok: true});
        }
        return sendJson(res, 404, {error: 'API route not found'});
      } catch (error) {
        console.error('Fluxion API error:', error);
        return sendJson(res, 500, {error: error instanceof Error && error.message.includes('Email could not be sent') ? error.message : 'Something went wrong. Check your server and database settings.'});
      }
    });
  }};
}
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!)); }
