import prisma from '../prisma';

export async function getSettings(): Promise<Record<string, string>> {
  const settings = await prisma.setting.findMany();
  const result: Record<string, string> = {};
  for (const s of settings) {
    result[s.key] = s.value;
  }
  return result;
}

export async function updateSettings(data: { businessName?: string }) {
  const updates: Array<{ key: string; value: string }> = [];

  if (data.businessName !== undefined) {
    const trimmed = data.businessName.trim();
    updates.push({ key: 'businessName', value: trimmed });

    // Sync admin/owner user's display name with businessName
    await prisma.user.updateMany({
      where: { role: 'ADMIN' },
      data: { name: trimmed },
    });
  }

  for (const { key, value } of updates) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  return getSettings();
}
