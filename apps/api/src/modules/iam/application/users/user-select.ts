import { Prisma } from '@prisma/client';

/** Never select passwordHash for anything that leaves the server. */
export const USER_SAFE_SELECT = {
  id: true,
  businessId: true,
  name: true,
  email: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;
