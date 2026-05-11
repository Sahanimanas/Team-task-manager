import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../lib/async";
import { loadProjectMembership, requireProjectMember } from "../middleware/rbac";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { notify } from "../lib/notify";

const router = Router();

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  teamId: z.string().min(1).optional().nullable(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional().nullable(),
  teamId: z.string().min(1).optional().nullable(),
});

const addMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
});

router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const where =
      req.user!.role === "ADMIN"
        ? {}
        : {
            OR: [
              { ownerId: userId },
              { members: { some: { userId } } },
              { team: { members: { some: { userId } } } },
            ],
          };
    const projects = await prisma.project.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true, email: true } },
        team: { select: { id: true, name: true } },
        _count: { select: { tasks: true, members: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ projects });
  }),
);

router.post(
  "/",
  validate(createProjectSchema),
  asyncHandler(async (req, res) => {
    const { name, description, teamId } = req.body as z.infer<typeof createProjectSchema>;
    const userId = req.user!.sub;
    if (teamId) {
      const teamMember = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
      });
      if (!teamMember && req.user!.role !== "ADMIN") {
        throw forbidden("You must be a member of the team to link it");
      }
    }
    const project = await prisma.project.create({
      data: {
        name,
        description,
        ownerId: userId,
        teamId: teamId ?? null,
        members: {
          create: { userId, role: "ADMIN" },
        },
      },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        team: { select: { id: true, name: true } },
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
      },
    });
    res.status(201).json({ project });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { project, role } = await loadProjectMembership(
      req.user!.sub,
      req.params.id,
      req.user!.role,
    );
    if (!project) throw notFound("Project not found");
    if (!role) throw forbidden("Not a project member");
    const full = await prisma.project.findUnique({
      where: { id: project.id },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        team: {
          include: {
            members: {
              include: { user: { select: { id: true, name: true, email: true } } },
              orderBy: { joinedAt: "asc" },
            },
          },
        },
        members: {
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { joinedAt: "asc" },
        },
      },
    });
    res.json({ project: full, myRole: role });
  }),
);

router.patch(
  "/:id",
  validate(updateProjectSchema),
  requireProjectMember(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateProjectSchema>;
    if (body.teamId) {
      const teamMember = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: body.teamId, userId: req.user!.sub } },
      });
      if (!teamMember && req.user!.role !== "ADMIN") {
        throw forbidden("You must be a member of the team to link it");
      }
    }
    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: body,
      include: {
        owner: { select: { id: true, name: true, email: true } },
        team: { select: { id: true, name: true } },
      },
    });
    res.json({ project });
  }),
);

router.delete(
  "/:id",
  requireProjectMember(["ADMIN"]),
  asyncHandler(async (req, res) => {
    await prisma.project.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

router.post(
  "/:id/members",
  validate(addMemberSchema),
  requireProjectMember(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const { userId, role } = req.body as z.infer<typeof addMemberSchema>;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound("User not found");
    const existing = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: req.params.id, userId } },
    });
    if (existing) throw badRequest("User already a member");
    const member = await prisma.projectMember.create({
      data: { projectId: req.params.id, userId, role },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    await notify({
      userId,
      type: "PROJECT_INVITED",
      message: `You were added to a project`,
      projectId: req.params.id,
    });
    res.status(201).json({ member });
  }),
);

router.delete(
  "/:id/members/:userId",
  requireProjectMember(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) throw notFound("Project not found");
    if (project.ownerId === req.params.userId)
      throw badRequest("Cannot remove the project owner");
    await prisma.projectMember.delete({
      where: { projectId_userId: { projectId: req.params.id, userId: req.params.userId } },
    });
    res.json({ ok: true });
  }),
);

router.patch(
  "/:id/members/:userId",
  requireProjectMember(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const role = req.body?.role === "ADMIN" ? "ADMIN" : "MEMBER";
    const member = await prisma.projectMember.update({
      where: { projectId_userId: { projectId: req.params.id, userId: req.params.userId } },
      data: { role },
    });
    res.json({ member });
  }),
);

export default router;
