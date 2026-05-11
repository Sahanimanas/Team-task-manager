import { PrismaClient, TaskPriority, TaskStatus } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding…");

  const passwordHash = await bcrypt.hash("password123", 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@demo.com" },
    update: {},
    create: {
      email: "admin@demo.com",
      name: "Ada Admin",
      passwordHash,
      globalRole: "ADMIN",
    },
  });

  const alice = await prisma.user.upsert({
    where: { email: "alice@demo.com" },
    update: {},
    create: {
      email: "alice@demo.com",
      name: "Alice Member",
      passwordHash,
      globalRole: "MEMBER",
    },
  });

  const bob = await prisma.user.upsert({
    where: { email: "bob@demo.com" },
    update: {},
    create: {
      email: "bob@demo.com",
      name: "Bob Member",
      passwordHash,
      globalRole: "MEMBER",
    },
  });

  // Clean prior demo data (idempotent re-seed)
  await prisma.task.deleteMany({});
  await prisma.projectMember.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.notification.deleteMany({});

  const launch = await prisma.project.create({
    data: {
      name: "Product Launch",
      description: "Get v1 of the product shipped.",
      ownerId: admin.id,
      members: {
        create: [
          { userId: admin.id, role: "ADMIN" },
          { userId: alice.id, role: "MEMBER" },
          { userId: bob.id, role: "MEMBER" },
        ],
      },
    },
  });

  const ops = await prisma.project.create({
    data: {
      name: "Internal Tooling",
      description: "Improve our internal dashboards.",
      ownerId: alice.id,
      members: {
        create: [
          { userId: alice.id, role: "ADMIN" },
          { userId: bob.id, role: "MEMBER" },
        ],
      },
    },
  });

  const now = Date.now();
  const days = (d: number) => new Date(now + d * 24 * 60 * 60 * 1000);

  await prisma.task.createMany({
    data: [
      {
        title: "Write landing page copy",
        description: "Hero, features, pricing.",
        projectId: launch.id,
        createdById: admin.id,
        assigneeId: alice.id,
        priority: TaskPriority.HIGH,
        status: TaskStatus.IN_PROGRESS,
        dueDate: days(3),
      },
      {
        title: "Set up CI pipeline",
        description: "GitHub Actions: build, test, deploy.",
        projectId: launch.id,
        createdById: admin.id,
        assigneeId: bob.id,
        priority: TaskPriority.MEDIUM,
        status: TaskStatus.TODO,
        dueDate: days(7),
      },
      {
        title: "Fix login button overdue",
        projectId: launch.id,
        createdById: admin.id,
        assigneeId: alice.id,
        priority: TaskPriority.HIGH,
        status: TaskStatus.TODO,
        dueDate: days(-2),
      },
      {
        title: "Design new dashboard",
        projectId: ops.id,
        createdById: alice.id,
        assigneeId: bob.id,
        priority: TaskPriority.LOW,
        status: TaskStatus.TODO,
        dueDate: days(10),
      },
      {
        title: "Migrate legacy reports",
        projectId: ops.id,
        createdById: alice.id,
        assigneeId: alice.id,
        priority: TaskPriority.MEDIUM,
        status: TaskStatus.DONE,
      },
    ],
  });

  await prisma.notification.createMany({
    data: [
      {
        userId: alice.id,
        type: "TASK_ASSIGNED",
        message: "You were assigned: Write landing page copy",
        projectId: launch.id,
      },
      {
        userId: bob.id,
        type: "TASK_ASSIGNED",
        message: "You were assigned: Set up CI pipeline",
        projectId: launch.id,
      },
    ],
  });

  console.log("Seed complete.");
  console.log("Logins (password: password123): admin@demo.com, alice@demo.com, bob@demo.com");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
