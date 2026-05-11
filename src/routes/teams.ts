import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../lib/async";
import { badRequest, forbidden, notFound, unauthorized } from "../lib/errors";
import { notify } from "../lib/notify";

const router = Router();

const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
});

const updateTeamSchema = createTeamSchema.partial();

const addMemberByIdSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
});

const addMemberByEmailSchema = z.object({
  email: z.string().email(),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
});

const addMemberSchema = z.union([addMemberByIdSchema, addMemberByEmailSchema]);

async function loadTeamMembership(
  userId: string,
  teamId: string,
  globalRole: "ADMIN" | "MEMBER",
) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { members: { where: { userId } } },
  });
  if (!team) return { team: null, role: null as null | "ADMIN" | "MEMBER" };
  const membership = team.members[0];
  if (membership) return { team, role: membership.role };
  if (globalRole === "ADMIN") return { team, role: "ADMIN" as const };
  return { team, role: null };
}

function requireTeamMember(roles: Array<"ADMIN" | "MEMBER"> = ["ADMIN", "MEMBER"]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    const teamId = req.params.teamId ?? req.params.id;
    if (!teamId) return next(forbidden("Team id required"));
    const { team, role } = await loadTeamMembership(req.user.sub, teamId, req.user.role);
    if (!team) return next(notFound("Team not found"));
    if (!role || !roles.includes(role)) return next(forbidden("Insufficient team permissions"));
    next();
  };
}

router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const where =
      req.user!.role === "ADMIN"
        ? {}
        : { OR: [{ ownerId: userId }, { members: { some: { userId } } }] };
    const teams = await prisma.team.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true, projects: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ teams });
  }),
);

router.post(
  "/",
  validate(createTeamSchema),
  asyncHandler(async (req, res) => {
    const { name, description } = req.body as z.infer<typeof createTeamSchema>;
    const userId = req.user!.sub;
    const team = await prisma.team.create({
      data: {
        name,
        description,
        ownerId: userId,
        members: { create: { userId, role: "ADMIN" } },
      },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
      },
    });
    res.status(201).json({ team });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { team, role } = await loadTeamMembership(
      req.user!.sub,
      req.params.id,
      req.user!.role,
    );
    if (!team) throw notFound("Team not found");
    if (!role) throw forbidden("Not a team member");
    const full = await prisma.team.findUnique({
      where: { id: team.id },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        members: {
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { joinedAt: "asc" },
        },
        projects: {
          select: { id: true, name: true, _count: { select: { tasks: true } } },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    res.json({ team: full, myRole: role });
  }),
);

router.patch(
  "/:id",
  validate(updateTeamSchema),
  requireTeamMember(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const team = await prisma.team.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json({ team });
  }),
);

router.delete(
  "/:id",
  requireTeamMember(["ADMIN"]),
  asyncHandler(async (req, res) => {
    await prisma.team.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

router.post(
  "/:id/members",
  validate(addMemberSchema),
  requireTeamMember(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof addMemberSchema>;
    const role = body.role;

    const user = "email" in body
      ? await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } })
      : await prisma.user.findUnique({ where: { id: body.userId } });
    if (!user) throw notFound("User not found");

    const existing = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: req.params.id, userId: user.id } },
    });
    if (existing) throw badRequest("User already a team member");

    const member = await prisma.teamMember.create({
      data: { teamId: req.params.id, userId: user.id, role },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    await notify({
      userId: user.id,
      type: "TEAM_INVITED",
      message: `You were added to a team`,
    });
    res.status(201).json({ member });
  }),
);

router.patch(
  "/:id/members/:userId",
  requireTeamMember(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const role = req.body?.role === "ADMIN" ? "ADMIN" : "MEMBER";
    const member = await prisma.teamMember.update({
      where: { teamId_userId: { teamId: req.params.id, userId: req.params.userId } },
      data: { role },
    });
    res.json({ member });
  }),
);

router.delete(
  "/:id/members/:userId",
  requireTeamMember(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const team = await prisma.team.findUnique({ where: { id: req.params.id } });
    if (!team) throw notFound("Team not found");
    if (team.ownerId === req.params.userId)
      throw badRequest("Cannot remove the team owner");
    await prisma.teamMember.delete({
      where: { teamId_userId: { teamId: req.params.id, userId: req.params.userId } },
    });
    res.json({ ok: true });
  }),
);

export default router;
