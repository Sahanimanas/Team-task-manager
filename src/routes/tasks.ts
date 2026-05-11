import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../lib/async";
import { loadProjectMembership } from "../middleware/rbac";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { notify } from "../lib/notify";

const router = Router();

router.use(requireAuth);

const createTaskSchema = z.object({
  title: z.string().min(1).max(160),
  description: z.string().max(4000).optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "DONE"]).default("TODO"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  dueDate: z.coerce.date().optional(),
  assigneeId: z.string().optional().nullable(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  description: z.string().max(4000).optional().nullable(),
  status: z.enum(["TODO", "IN_PROGRESS", "DONE"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  dueDate: z.coerce.date().optional().nullable(),
  assigneeId: z.string().optional().nullable(),
});

const listQuerySchema = z.object({
  status: z.enum(["TODO", "IN_PROGRESS", "DONE"]).optional(),
  assigneeId: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  mine: z.coerce.boolean().optional(),
  overdue: z.coerce.boolean().optional(),
});

async function ensureMembership(req: any, projectId: string) {
  const { project, role } = await loadProjectMembership(req.user.sub, projectId, req.user.role);
  if (!project) throw notFound("Project not found");
  if (!role) throw forbidden("Not a project member");
  return { project, role };
}

router.get(
  "/projects/:projectId/tasks",
  validate(listQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    await ensureMembership(req, req.params.projectId);
    const q = req.query as z.infer<typeof listQuerySchema>;
    const tasks = await prisma.task.findMany({
      where: {
        projectId: req.params.projectId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.priority ? { priority: q.priority } : {}),
        ...(q.assigneeId ? { assigneeId: q.assigneeId } : {}),
        ...(q.mine ? { assigneeId: req.user!.sub } : {}),
        ...(q.overdue
          ? { dueDate: { lt: new Date() }, status: { not: "DONE" } }
          : {}),
      },
      include: {
        assignee: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
    });
    res.json({ tasks });
  }),
);

router.post(
  "/projects/:projectId/tasks",
  validate(createTaskSchema),
  asyncHandler(async (req, res) => {
    await ensureMembership(req, req.params.projectId);
    const body = req.body as z.infer<typeof createTaskSchema>;
    if (body.assigneeId) {
      const m = await prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId: req.params.projectId, userId: body.assigneeId },
        },
      });
      if (!m) {
        const project = await prisma.project.findUnique({
          where: { id: req.params.projectId },
          select: { teamId: true },
        });
        const teamMember = project?.teamId
          ? await prisma.teamMember.findUnique({
              where: { teamId_userId: { teamId: project.teamId, userId: body.assigneeId } },
            })
          : null;
        if (!teamMember) throw badRequest("Assignee must be a project or team member");
      }
    }
    const task = await prisma.task.create({
      data: {
        ...body,
        projectId: req.params.projectId,
        createdById: req.user!.sub,
      },
      include: {
        assignee: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
    if (task.assigneeId && task.assigneeId !== req.user!.sub) {
      await notify({
        userId: task.assigneeId,
        type: "TASK_ASSIGNED",
        message: `You were assigned: ${task.title}`,
        taskId: task.id,
        projectId: task.projectId,
      });
    }
    res.status(201).json({ task });
  }),
);

router.get(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: {
        assignee: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true } },
      },
    });
    if (!task) throw notFound("Task not found");
    await ensureMembership(req, task.projectId);
    res.json({ task });
  }),
);

router.patch(
  "/tasks/:id",
  validate(updateTaskSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound("Task not found");
    const { role } = await ensureMembership(req, existing.projectId);
    const body = req.body as z.infer<typeof updateTaskSchema>;

    const isProjectAdmin = role === "ADMIN";
    const isAssignee = existing.assigneeId === req.user!.sub;
    const isCreator = existing.createdById === req.user!.sub;

    // Members can only update tasks they created or are assigned to.
    // They can change status freely but not reassign or change title/description if not creator.
    if (!isProjectAdmin) {
      if (!isAssignee && !isCreator) throw forbidden("Cannot edit this task");
      if (body.assigneeId !== undefined && !isCreator) {
        throw forbidden("Only creators or project admins can reassign");
      }
    }

    if (body.assigneeId) {
      const m = await prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId: existing.projectId, userId: body.assigneeId },
        },
      });
      if (!m) {
        const project = await prisma.project.findUnique({
          where: { id: existing.projectId },
          select: { teamId: true },
        });
        const teamMember = project?.teamId
          ? await prisma.teamMember.findUnique({
              where: { teamId_userId: { teamId: project.teamId, userId: body.assigneeId } },
            })
          : null;
        if (!teamMember) throw badRequest("Assignee must be a project or team member");
      }
    }

    const task = await prisma.task.update({
      where: { id: req.params.id },
      data: body,
      include: {
        assignee: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    // Notifications
    if (
      body.assigneeId !== undefined &&
      body.assigneeId !== existing.assigneeId &&
      body.assigneeId
    ) {
      await notify({
        userId: body.assigneeId,
        type: "TASK_ASSIGNED",
        message: `You were assigned: ${task.title}`,
        taskId: task.id,
        projectId: task.projectId,
      });
    }
    if (body.status && body.status !== existing.status) {
      const watcher = task.assigneeId && task.assigneeId !== req.user!.sub
        ? task.assigneeId
        : existing.createdById !== req.user!.sub
          ? existing.createdById
          : null;
      if (watcher) {
        await notify({
          userId: watcher,
          type: "TASK_STATUS_CHANGED",
          message: `Status changed to ${body.status}: ${task.title}`,
          taskId: task.id,
          projectId: task.projectId,
        });
      }
    }

    res.json({ task });
  }),
);

router.delete(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    const existing = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound("Task not found");
    const { role } = await ensureMembership(req, existing.projectId);
    const isProjectAdmin = role === "ADMIN";
    const isCreator = existing.createdById === req.user!.sub;
    if (!isProjectAdmin && !isCreator) throw forbidden("Cannot delete this task");
    await prisma.task.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

export default router;
