import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { config } from './config';

const PG_PORT = 54332;
const PID_FILE = path.resolve(__dirname, '../data/db/postmaster.pid');

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function main() {
  const pg = new EmbeddedPostgres({
    port: PG_PORT,
    user: 'postgres',
    password: 'password',
  });

  const alreadyRunning = await isPortOpen(PG_PORT);
  if (alreadyRunning) {
    console.log(`PostgreSQL is already active on port ${PG_PORT}. Reusing instance.`);
  } else {
    // Clean up stale lock file if left behind from previous ungraceful shutdown
    if (fs.existsSync(PID_FILE)) {
      try {
        fs.unlinkSync(PID_FILE);
        console.log('Removed stale postmaster.pid lock file.');
      } catch (err) {
        console.warn('Could not remove stale postmaster.pid:', err);
      }
    }

    console.log('Starting embedded PostgreSQL...');
    try {
      await pg.initialise();
    } catch {
      console.log('PostgreSQL data directory already initialized');
    }

    try {
      await pg.start();
      console.log(`Embedded PostgreSQL running on port ${PG_PORT}`);
    } catch (startErr: any) {
      // Double check if it became reachable in the meantime
      const active = await isPortOpen(PG_PORT);
      if (active) {
        console.log(`PostgreSQL is reachable on port ${PG_PORT}. Continuing.`);
      } else {
        throw startErr;
      }
    }
  }

  // Create the database (ignore error if already exists)
  try {
    await pg.createDatabase('sms_db');
    console.log('Database sms_db created');
  } catch {
    console.log('Database sms_db ready');
  }

  // Run Prisma migrations
  console.log('Running Prisma migrations...');
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: config.databaseUrl },
  });
  console.log('Migrations applied');

  // Run database seeder
  try {
    console.log('Running seed...');
    execSync('npx tsx prisma/seed.ts', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
    });
    console.log('Seed applied');
  } catch (seedErr) {
    console.warn('Seed warning:', seedErr);
  }

  // Import app after migrations so Prisma client is ready
  const { default: app } = await import('./app');

  const server = app.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    server.close();
    try {
      await pg.stop();
    } catch {
      // Ignore errors on shutdown
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
