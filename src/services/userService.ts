import bcrypt from 'bcryptjs';
import prisma from '../prisma';
import { AppError } from '../middleware/errorHandler';
import { Role } from '@prisma/client';

const userSelectWithoutPassword = {
  id: true,
  username: true,
  name: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
};

export async function listUsers() {
  return prisma.user.findMany({
    select: userSelectWithoutPassword,
    orderBy: { createdAt: 'asc' },
  });
}

export async function createUser(data: { username: string; password: string; name: string }) {
  // Check for duplicate username
  const existing = await prisma.user.findUnique({ where: { username: data.username } });
  if (existing) {
    throw new AppError(409, 'USERNAME_EXISTS', 'Username already exists');
  }

  const passwordHash = await bcrypt.hash(data.password, 12);

  const user = await prisma.user.create({
    data: {
      username: data.username,
      passwordHash,
      name: data.name,
      role: Role.ASSISTANT,
    },
    select: userSelectWithoutPassword,
  });

  return user;
}

export async function updateUser(
  id: string,
  data: { name?: string; isActive?: boolean }
) {
  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  }

  // Cannot deactivate admin
  if (data.isActive === false && user.role === Role.ADMIN) {
    throw new AppError(400, 'CANNOT_DEACTIVATE_ADMIN', 'Cannot deactivate admin user');
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
    select: userSelectWithoutPassword,
  });

  // If updating admin name, also keep businessName setting in sync
  if (data.name && user.role === Role.ADMIN) {
    const trimmed = data.name.trim();
    await prisma.setting.upsert({
      where: { key: 'businessName' },
      create: { key: 'businessName', value: trimmed },
      update: { value: trimmed },
    });
  }

  return updated;
}

export async function resetPassword(
  id: string,
  newPassword: string,
  requestingUserId: string
) {
  // Cannot reset own password this way
  if (id === requestingUserId) {
    throw new AppError(400, 'CANNOT_RESET_OWN', 'Cannot reset your own password this way. Use change-password instead.');
  }

  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  }

  if (user.role !== Role.ASSISTANT) {
    throw new AppError(400, 'INVALID_ROLE', 'Can only reset passwords for Assistant accounts');
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  await prisma.user.update({
    where: { id },
    data: { passwordHash },
  });
}
