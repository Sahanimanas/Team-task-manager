import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

async function signup(email: string) {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "password123", name: email.split("@")[0] });
  return res.body.accessToken as string;
}

describe("projects + tasks", () => {
  const ownerEmail = `owner+${Date.now()}@example.com`;
  const otherEmail = `other+${Date.now()}@example.com`;
  let ownerToken = "";
  let otherToken = "";
  let projectId = "";

  beforeAll(async () => {
    ownerToken = await signup(ownerEmail);
    otherToken = await signup(otherEmail);
  });

  it("creates a project", async () => {
    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Test Project", description: "x" });
    expect(res.status).toBe(201);
    projectId = res.body.project.id;
  });

  it("blocks non-members from viewing", async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("creates a task", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ title: "First task", priority: "HIGH" });
    expect(res.status).toBe(201);
    expect(res.body.task.title).toBe("First task");
  });

  it("validates task input", async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ title: "" });
    expect(res.status).toBe(400);
  });
});
