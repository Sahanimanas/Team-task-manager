import { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { forbidden, notFound, unauthorized } from "../lib/errors";

export function requireGlobalAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== "ADMIN") return next(forbidden("Admin only"));
  next();
}

export async function loadProjectMembership(
  userId: string,
  projectId: string,
  globalRole: "ADMIN" | "MEMBER",
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      members: { where: { userId } },
      team: { include: { members: { where: { userId } } } },
    },
  });
  if (!project) return { project: null, role: null as null | "ADMIN" | "MEMBER" };
  const membership = project.members[0];
  if (membership) return { project, role: membership.role };
  const teamMembership = project.team?.members?.[0];
  if (teamMembership) {
    return { project, role: teamMembership.role };
  }
  if (globalRole === "ADMIN") return { project, role: "ADMIN" as const };
  return { project, role: null };
}

export function requireProjectMember(roles: Array<"ADMIN" | "MEMBER"> = ["ADMIN", "MEMBER"]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    const projectId = req.params.projectId ?? req.params.id;
    if (!projectId) return next(forbidden("Project id required"));
    const { project, role } = await loadProjectMembership(
      req.user.sub,
      projectId,
      req.user.role,
    );
    if (!project) return next(notFound("Project not found"));
    if (!role || !roles.includes(role)) return next(forbidden("Insufficient project permissions"));
    next();
  };
}
