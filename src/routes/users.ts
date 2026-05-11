import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireGlobalAdmin } from "../middleware/rbac";
import { asyncHandler } from "../lib/async";

const router = Router();

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { id: true, email: true, name: true, globalRole: true, createdAt: true },
    });
    res.json({ user });
  }),
);

router.get(
  "/",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, name: true, globalRole: true },
      orderBy: { name: "asc" },
    });
    res.json({ users });
  }),
);

router.patch(
  "/:id/role",
  requireAuth,
  requireGlobalAdmin,
  asyncHandler(async (req, res) => {
    const role = req.body?.role === "ADMIN" ? "ADMIN" : "MEMBER";
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { globalRole: role },
      select: { id: true, email: true, name: true, globalRole: true },
    });
    res.json({ user });
  }),
);

export default router;
