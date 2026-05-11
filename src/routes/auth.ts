import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../lib/async";
import { badRequest, conflict, unauthorized } from "../lib/errors";
import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  ttlToMs,
  verifyRefreshToken,
} from "../lib/jwt";
import { env } from "../lib/env";
import crypto from "crypto";

const router = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(100),
  name: z.string().min(1).max(80),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

async function issueTokens(user: { id: string; email: string; globalRole: "ADMIN" | "MEMBER" }) {
  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.globalRole,
  });
  const jti = crypto.randomUUID();
  const refreshToken = signRefreshToken({ sub: user.id, jti });
  const expiresAt = new Date(Date.now() + ttlToMs(env.jwtRefreshTtl));
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt,
    },
  });
  return { accessToken, refreshToken };
}

router.post(
  "/signup",
  validate(signupSchema),
  asyncHandler(async (req, res) => {
    const { email, password, name } = req.body as z.infer<typeof signupSchema>;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw conflict("Email already registered");
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, name, passwordHash },
    });
    const tokens = await issueTokens(user);
    res.status(201).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.globalRole },
      ...tokens,
    });
  }),
);

router.post(
  "/login",
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw unauthorized("Invalid credentials");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw unauthorized("Invalid credentials");
    const tokens = await issueTokens(user);
    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.globalRole },
      ...tokens,
    });
  }),
);

router.post(
  "/refresh",
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      throw unauthorized("Invalid refresh token");
    }
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      throw unauthorized("Refresh token revoked or expired");
    }
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw unauthorized("User missing");
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revoked: true },
    });
    const tokens = await issueTokens(user);
    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.globalRole },
      ...tokens,
    });
  }),
);

router.post(
  "/logout",
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (stored && !stored.revoked) {
      await prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revoked: true },
      });
    }
    res.json({ ok: true });
  }),
);

export default router;
