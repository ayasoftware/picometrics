/**
 * Dev seed: creates one admin user and one workspace.
 * Run with: npx tsx packages/backend/scripts/seed.ts
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import * as schema from "../src/db/schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const db = drizzle(pool, { schema });

async function seed() {
  console.log("Seeding...");

  const passwordHash = await bcrypt.hash("password123", 12);
  const [user] = await db
    .insert(schema.users)
    .values({ email: "admin@example.com", passwordHash, fullName: "Admin User" })
    .onConflictDoNothing()
    .returning();

  if (!user) {
    console.log("User already exists, skipping.");
    await pool.end();
    return;
  }

  const [ws] = await db
    .insert(schema.workspaces)
    .values({ name: "My Workspace", slug: "my-workspace", ownerId: user.id })
    .returning();

  await db.insert(schema.workspaceMembers).values({
    workspaceId: ws!.id,
    userId: user.id,
    role: "owner",
  });

  console.log(`Created user: admin@example.com / password123`);
  console.log(`Created workspace: ${ws!.name} (${ws!.id})`);
  await pool.end();
}

seed().catch((err) => { console.error(err); process.exit(1); });
