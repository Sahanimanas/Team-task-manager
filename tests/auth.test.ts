import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

describe("auth", () => {
  const email = `tester+${Date.now()}@example.com`;
  let accessToken = "";
  let refreshToken = "";

  it("signs up a new user", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "password123", name: "Tester" });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    accessToken = res.body.accessToken;
    refreshToken = res.body.refreshToken;
  });

  it("rejects duplicate signups", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "password123", name: "Tester" });
    expect(res.status).toBe(409);
  });

  it("logs in with valid credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it("rejects invalid credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "wrongpass" });
    expect(res.status).toBe(401);
  });

  it("returns current user with valid access token", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });

  it("refreshes tokens", async () => {
    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });
});
