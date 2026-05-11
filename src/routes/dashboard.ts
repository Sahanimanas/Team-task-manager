import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/async";

const router = Router();

router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user!.sub;
    const isAdmin = req.user!.role === "ADMIN";

    const projectsWhere = isAdmin
      ? {}
      : {
          OR: [
            { ownerId: userId },
            { members: { some: { userId } } },
            { team: { members: { some: { userId } } } },
          ],
        };

    const projectIds = (
      await prisma.project.findMany({ where: projectsWhere, select: { id: true } })
    ).map((p) => p.id);

    const scopedTasks = { projectId: { in: projectIds } };

    const [
      myTasks,
      tasksByStatus,
      overdue,
      recent,
      projectsCount,
    ] = await Promise.all([
      prisma.task.findMany({
        where: { assigneeId: userId, ...scopedTasks },
        include: {
          project: { select: { id: true, name: true } },
        },
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        take: 20,
      }),
      prisma.task.groupBy({
        by: ["status"],
        where: scopedTasks,
        _count: true,
      }),
      prisma.task.findMany({
        where: {
          ...scopedTasks,
          dueDate: { lt: new Date() },
          status: { not: "DONE" },
        },
        include: {
          assignee: { select: { id: true, name: true, email: true } },
          project: { select: { id: true, name: true } },
        },
        orderBy: { dueDate: "asc" },
        take: 20,
      }),
      prisma.task.findMany({
        where: scopedTasks,
        include: {
          assignee: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 8,
      }),
      prisma.project.count({ where: projectsWhere }),
    ]);

    const statusMap: Record<string, number> = { TODO: 0, IN_PROGRESS: 0, DONE: 0 };
    tasksByStatus.forEach((row) => {
      statusMap[row.status] = row._count;
    });

    res.json({
      myTasks,
      overdue,
      recent,
      stats: {
        projects: projectsCount,
        todo: statusMap.TODO,
        inProgress: statusMap.IN_PROGRESS,
        done: statusMap.DONE,
        overdueCount: overdue.length,
      },
    });
  }),
);

export default router;
