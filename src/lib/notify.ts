import { NotificationType } from "@prisma/client";
import { prisma } from "./prisma";

export async function notify(params: {
  userId: string;
  type: NotificationType;
  message: string;
  taskId?: string;
  projectId?: string;
}) {
  if (!params.userId) return;
  await prisma.notification.create({ data: params });
}
