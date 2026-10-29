import { prisma } from '@carbooking/db';
import { env, stopBoss } from '@carbooking/server';
import { buildApp } from './app';

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.warn(`${signal} received, shutting down`);
  await app.close();
  await stopBoss();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
console.log(`API listening on :${env.API_PORT} (auth: ${env.AUTH_MODE}, storage: ${env.STORAGE_DRIVER})`);
