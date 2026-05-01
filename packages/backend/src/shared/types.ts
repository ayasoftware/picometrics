import type { Request } from "express";

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";
export type OAuthProvider = "google" | "linkedin" | "facebook";

export interface AuthPayload {
  sub: string;      // user ID
  type: "access" | "refresh";
}

export interface AuthenticatedRequest extends Request {
  userId: string;
  workspaceId?: string;
  workspaceRole?: WorkspaceRole;
}
