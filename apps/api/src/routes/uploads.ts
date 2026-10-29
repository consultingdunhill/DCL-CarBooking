import { DomainError, forbidden, UploadRequestSchema } from '@carbooking/core';
import type { FastifyInstance } from 'fastify';
import { isAdmin, me } from '../lib/auth';
import { parse } from '../lib/http';
import { isSafeKey, newKey, readLocal, storage, writeLocal } from '../lib/storage';
import { verifyPathSignature } from '../lib/tokens';

const MAX_UPLOAD = 15 * 1024 * 1024;

export async function uploadRoutes(app: FastifyInstance) {
  /** A short-lived URL the client PUTs the file to directly. */
  app.post('/uploads', async (req) => {
    const user = me(req);
    const body = parse(UploadRequestSchema, req.body);
    if (body.kind === 'RECEIPT' && !isAdmin(req)) throw forbidden();
    const key = newKey(body.kind, body.contentType, user.id);
    return { key, ...(await storage.createUploadUrl(key, body.contentType)) };
  });

  /** Signed URL for viewing a stored file. Admins see any; staff see what they uploaded. */
  app.get<{ Querystring: { key: string } }>('/files', async (req) => {
    const user = me(req);
    const key = req.query.key ?? '';
    if (!isSafeKey(key)) throw new DomainError('BAD_KEY', 'Unknown file', 404);
    if (!isAdmin(req) && !key.includes(`/${user.id.slice(0, 8)}-`)) throw forbidden();
    return { url: await storage.readUrl(key) };
  });

  // ── Local storage driver (development) ──────────────────────────────────────

  await app.register(async (scoped) => {
    scoped.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (_req, body, done) => done(null, body));

    scoped.put<{ Params: { '*': string }; Querystring: { exp: string; sig: string } }>(
      '/uploads/local/*',
      { config: { auth: 'public' }, bodyLimit: MAX_UPLOAD },
      async (req, reply) => {
        const key = req.params['*'];
        if (!isSafeKey(key) || !verifyPathSignature(`PUT:${key}`, Number(req.query.exp), req.query.sig ?? '')) {
          throw new DomainError('BAD_SIGNATURE', 'Upload link expired or invalid', 403);
        }
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) throw new DomainError('EMPTY_UPLOAD', 'The file is empty');
        await writeLocal(key, body);
        reply.code(201);
        return { key };
      },
    );

    scoped.get<{ Params: { '*': string }; Querystring: { exp: string; sig: string } }>(
      '/files/local/*',
      { config: { auth: 'public' } },
      async (req, reply) => {
        const key = req.params['*'];
        if (!isSafeKey(key) || !verifyPathSignature(`GET:${key}`, Number(req.query.exp), req.query.sig ?? '')) {
          throw new DomainError('BAD_SIGNATURE', 'Link expired or invalid', 403);
        }
        if (key.startsWith('seed/')) {
          reply.type('image/svg+xml');
          return PLACEHOLDER_SVG;
        }
        const stream = readLocal(key);
        if (!stream) throw new DomainError('NOT_FOUND', 'File not found', 404);
        const ext = key.split('.').pop();
        reply.type(ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'pdf' ? 'application/pdf' : 'image/jpeg');
        reply.header('Cache-Control', 'private, max-age=3600');
        return reply.send(stream);
      },
    );
  });
}

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260"><rect width="400" height="260" fill="#1f2937"/><text x="200" y="120" fill="#9ca3af" font-family="sans-serif" font-size="18" text-anchor="middle">Odometer photo</text><text x="200" y="150" fill="#6b7280" font-family="sans-serif" font-size="13" text-anchor="middle">(sample data)</text></svg>`;
