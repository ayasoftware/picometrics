import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { ConflictError, UnauthorizedError, NotFoundError } from "../../shared/errors";
import type { NewUser, User } from "../../db/schema";

export async function registerUser(data: {
  email: string;
  password: string;
  fullName: string;
}): Promise<User> {
  const existing = await db.select().from(users).where(eq(users.email, data.email.toLowerCase())).limit(1);
  if (existing.length > 0) throw new ConflictError("Email already registered");

  const passwordHash = await bcrypt.hash(data.password, 12);
  const [user] = await db
    .insert(users)
    .values({
      email: data.email.toLowerCase(),
      passwordHash,
      fullName: data.fullName,
    } satisfies Omit<NewUser, "id" | "createdAt" | "updatedAt">)
    .returning();

  return user!;
}

export async function validateCredentials(email: string, password: string): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user || !user.passwordHash) throw new UnauthorizedError("Invalid credentials");
  if (!user.isActive) throw new UnauthorizedError("Account disabled");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new UnauthorizedError("Invalid credentials");

  return user;
}

export async function getUserById(id: string): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!user) throw new NotFoundError("User");
  return user;
}

export async function updateUser(id: string, data: { fullName?: string; password?: string }): Promise<User> {
  const updates: Partial<User> = { updatedAt: new Date() };
  if (data.fullName) updates.fullName = data.fullName;
  if (data.password) updates.passwordHash = await bcrypt.hash(data.password, 12);

  const [user] = await db.update(users).set(updates).where(eq(users.id, id)).returning();
  if (!user) throw new NotFoundError("User");
  return user;
}
