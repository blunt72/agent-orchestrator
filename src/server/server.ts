import Fastify, { FastifyInstance } from "fastify";
import { TaskEngine } from "../tasks/task-engine.js";
import { taskRoutes } from "./routes/tasks.js";
import { projectRoutes } from "./routes/projects.js";
import { renderDashboardHtml } from "./dashboard.js";

export interface ServerOptions {
  engine?: TaskEngine;
  port?: number;
  host?: string;
  logger?: boolean;
}

export function createServer(engine: TaskEngine, logger: boolean = false): FastifyInstance {
  const app = Fastify({
    logger,
  });

  // Health check
  app.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Web Dashboard
  app.get("/", async (request, reply) => {
    reply.type("text/html; charset=utf-8").send(renderDashboardHtml());
  });

  app.get("/dashboard", async (request, reply) => {
    reply.type("text/html; charset=utf-8").send(renderDashboardHtml());
  });

  // Register API routes
  app.register(async (apiApp) => {
    await apiApp.register(taskRoutes, { engine });
    await apiApp.register(projectRoutes, { engine });
  }, { prefix: "/api" });

  return app;
}

export async function startServer(options?: ServerOptions): Promise<{ app: FastifyInstance; port: number; url: string }> {
  const port = options?.port ?? 3000;
  const host = options?.host || "127.0.0.1";
  const engine = options?.engine || new TaskEngine();

  const app = createServer(engine, options?.logger ?? false);

  await app.listen({ port, host });
  await engine.recoverPendingTasks();
  const address = app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;

  return { app, port: actualPort, url };
}
