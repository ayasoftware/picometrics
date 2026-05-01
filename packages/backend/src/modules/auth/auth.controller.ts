import type { Request, Response, NextFunction } from "express";
import * as authService from "./auth.service";
import * as tokenService from "./token.service";
import type { AuthenticatedRequest } from "../../shared/types";

const REFRESH_COOKIE = "refresh_token";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, fullName } = req.body;
    const user = await authService.registerUser({ email, password, fullName });
    const accessToken = tokenService.signAccessToken(user.id);
    const raw = await tokenService.createRefreshToken(user.id, {
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });
    res.cookie(REFRESH_COOKIE, raw, COOKIE_OPTS);
    res.status(201).json({ accessToken, user: { id: user.id, email: user.email, fullName: user.fullName } });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;
    const user = await authService.validateCredentials(email, password);
    const accessToken = tokenService.signAccessToken(user.id);
    const raw = await tokenService.createRefreshToken(user.id, {
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });
    res.cookie(REFRESH_COOKIE, raw, COOKIE_OPTS);
    res.json({ accessToken, user: { id: user.id, email: user.email, fullName: user.fullName } });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "No refresh token" } });
      return;
    }
    const userId = await tokenService.consumeRefreshToken(raw);
    const accessToken = tokenService.signAccessToken(userId);
    const newRaw = await tokenService.createRefreshToken(userId, {
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });
    res.cookie(REFRESH_COOKIE, newRaw, COOKIE_OPTS);
    res.json({ accessToken });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const raw = req.cookies[REFRESH_COOKIE];
    if (raw) await tokenService.consumeRefreshToken(raw).catch(() => {});
    res.clearCookie(REFRESH_COOKIE);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function logoutAll(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await tokenService.revokeAllRefreshTokens(req.userId);
    res.clearCookie(REFRESH_COOKIE);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function me(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const user = await authService.getUserById(req.userId);
    res.json({ id: user.id, email: user.email, fullName: user.fullName, avatarUrl: user.avatarUrl });
  } catch (err) {
    next(err);
  }
}

export async function updateMe(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const user = await authService.updateUser(req.userId, req.body);
    res.json({ id: user.id, email: user.email, fullName: user.fullName });
  } catch (err) {
    next(err);
  }
}
