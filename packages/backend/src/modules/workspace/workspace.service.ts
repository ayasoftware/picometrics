import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { workspaces, workspaceMembers, users } from "../../db/schema";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors";
import type { Workspace } from "../../db/schema";

export async function createWorkspace(ownerId: string, data: { name: string; slug: string }): Promise<Workspace> {
  const existing = await db.select().from(workspaces).where(eq(workspaces.slug, data.slug)).limit(1);
  if (existing.length > 0) throw new ConflictError("Workspace slug already taken");

  const [ws] = await db.transaction(async (tx) => {
    const [ws] = await tx.insert(workspaces).values({ name: data.name, slug: data.slug, ownerId }).returning();
    await tx.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: ownerId, role: "owner" });
    return [ws!];
  });

  return ws!;
}

export async function listWorkspacesForUser(userId: string): Promise<Workspace[]> {
  const rows = await db
    .select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId));
  return rows.map((r) => r.workspace);
}

export async function getWorkspace(id: string): Promise<Workspace> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  if (!ws) throw new NotFoundError("Workspace");
  return ws;
}

export async function updateWorkspace(id: string, data: Partial<Pick<Workspace, "name" | "slug">>): Promise<Workspace> {
  if (data.slug) {
    const existing = await db.select().from(workspaces).where(and(eq(workspaces.slug, data.slug))).limit(1);
    if (existing.length > 0 && existing[0]!.id !== id) throw new ConflictError("Slug already taken");
  }
  const [ws] = await db.update(workspaces).set({ ...data, updatedAt: new Date() }).where(eq(workspaces.id, id)).returning();
  if (!ws) throw new NotFoundError("Workspace");
  return ws;
}

export async function deleteWorkspace(id: string): Promise<void> {
  await db.delete(workspaces).where(eq(workspaces.id, id));
}

export async function listMembers(workspaceId: string) {
  return db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
      email: users.email,
      fullName: users.fullName,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
}

export async function inviteMember(workspaceId: string, invitedBy: string, email: string, role: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user) throw new NotFoundError("User with that email");

  const existing = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)))
    .limit(1);
  if (existing.length > 0) throw new ConflictError("User is already a member");

  await db.insert(workspaceMembers).values({ workspaceId, userId: user.id, role, invitedBy });
  return { userId: user.id, email: user.email, role };
}

export async function updateMemberRole(workspaceId: string, userId: string, role: string) {
  if (role === "owner") throw new ForbiddenError("Cannot assign owner role via this endpoint");
  const [m] = await db
    .update(workspaceMembers)
    .set({ role })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .returning();
  if (!m) throw new NotFoundError("Member");
  return m;
}

export async function removeMember(workspaceId: string, userId: string, actorRole: string) {
  const [m] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (!m) throw new NotFoundError("Member");
  if (m.role === "owner") throw new ForbiddenError("Cannot remove the workspace owner");
  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
}
