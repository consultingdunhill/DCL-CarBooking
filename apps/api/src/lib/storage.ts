import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { BlobSASPermissions, BlobServiceClient, generateBlobSASQueryParameters, StorageSharedKeyCredential } from '@azure/storage-blob';
import { env } from '@carbooking/server';
import { signPath } from './tokens';

/**
 * Photos and receipts. Uploads go straight to storage through short-lived
 * signed URLs; the API never proxies the file in production (Azure). The local
 * driver is for development.
 */
export interface Storage {
  createUploadUrl(key: string, contentType: string): Promise<{ url: string; method: 'PUT'; headers: Record<string, string> }>;
  exists(key: string): Promise<boolean>;
  readUrl(key: string, ttlSec?: number): Promise<string>;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};

export function newKey(kind: string, contentType: string, userId: string): string {
  const d = new Date();
  return `${kind.toLowerCase()}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${userId.slice(0, 8)}-${randomUUID()}.${EXT[contentType] ?? 'bin'}`;
}

export const isSafeKey = (key: string) => /^[a-z_]+\/\d{4}\/\d{2}\/[a-z0-9-]+\.[a-z]+$/.test(key) || key.startsWith('seed/');

// ── Local disk ────────────────────────────────────────────────────────────────

export const localDir = resolve(env.STORAGE_LOCAL_DIR ?? join(process.cwd(), 'storage'));

export function localPath(key: string): string {
  const p = normalize(join(localDir, key));
  if (!p.startsWith(localDir)) throw new Error('Bad key');
  return p;
}

class LocalStorage implements Storage {
  async createUploadUrl(key: string) {
    const exp = Math.floor(Date.now() / 1000) + 15 * 60;
    const sig = signPath(`PUT:${key}`, exp);
    return { url: `${env.API_PUBLIC_URL}/uploads/local/${key}?exp=${exp}&sig=${sig}`, method: 'PUT' as const, headers: {} };
  }
  async exists(key: string) {
    if (key.startsWith('seed/')) return true;
    try {
      return (await stat(localPath(key))).isFile();
    } catch {
      return false;
    }
  }
  async readUrl(key: string, ttlSec = 3600) {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = signPath(`GET:${key}`, exp);
    return `${env.API_PUBLIC_URL}/files/local/${key}?exp=${exp}&sig=${sig}`;
  }
}

export async function writeLocal(key: string, data: Buffer) {
  const p = localPath(key);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data);
}

export function readLocal(key: string) {
  const p = localPath(key);
  return existsSync(p) ? createReadStream(p) : null;
}

// ── Azure Blob Storage ────────────────────────────────────────────────────────

class AzureStorage implements Storage {
  private cred = new StorageSharedKeyCredential(env.AZURE_STORAGE_ACCOUNT!, env.AZURE_STORAGE_KEY!);
  private service = new BlobServiceClient(`https://${env.AZURE_STORAGE_ACCOUNT}.blob.core.windows.net`, this.cred);
  private container = this.service.getContainerClient(env.AZURE_STORAGE_CONTAINER);

  private sas(key: string, permissions: string, ttlSec: number, contentType?: string) {
    const sas = generateBlobSASQueryParameters(
      {
        containerName: env.AZURE_STORAGE_CONTAINER,
        blobName: key,
        permissions: BlobSASPermissions.parse(permissions),
        startsOn: new Date(Date.now() - 60_000),
        expiresOn: new Date(Date.now() + ttlSec * 1000),
        contentType,
      },
      this.cred,
    ).toString();
    return `${this.container.getBlockBlobClient(key).url}?${sas}`;
  }
  async createUploadUrl(key: string, contentType: string) {
    return {
      url: this.sas(key, 'cw', 15 * 60),
      method: 'PUT' as const,
      headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': contentType },
    };
  }
  async exists(key: string) {
    if (key.startsWith('seed/')) return true;
    return this.container.getBlockBlobClient(key).exists();
  }
  async readUrl(key: string, ttlSec = 3600) {
    return this.sas(key, 'r', ttlSec);
  }
}

export const storage: Storage = env.STORAGE_DRIVER === 'azure' ? new AzureStorage() : new LocalStorage();
