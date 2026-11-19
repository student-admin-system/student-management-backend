import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { config } from '../src/config';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create admin user
  const passwordHash = await bcrypt.hash(config.admin.password, 12);

  await prisma.user.upsert({
    where: { username: config.admin.username },
    update: {},
    create: {
      username: config.admin.username,
      passwordHash,
      name: config.admin.name,
      role: 'ADMIN',
    },
  });
  console.log(`Admin user "${config.admin.username}" created/verified`);

  // Upsert businessName setting
  await prisma.setting.upsert({
    where: { key: 'businessName' },
    update: {},
    create: {
      key: 'businessName',
      value: config.defaultBusinessName,
    },
  });
  console.log(`Setting "businessName" set to "${config.defaultBusinessName}"`);

  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
