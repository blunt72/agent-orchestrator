import { FastifyPluginAsync } from "fastify";
import { ProjectEngine } from "../../projects/project-engine.js";

export interface ProjectRouteOptions {
  engine: ProjectEngine;
}

export const projectRoutes: FastifyPluginAsync<ProjectRouteOptions> = async (fastify, opts) => {
  const { engine } = opts;

  // POST /api/projects - Create Project
  fastify.post<{
    Body: {
      id?: string;
      name: string;
      workspace?: string;
      description?: string;
    };
  }>("/projects", async (request, reply) => {
    const input = request.body;
    if (!input || !input.name) {
      reply.status(400);
      return { error: "Missing required field: name is required." };
    }

    try {
      const project = await engine.createProject(input);
      reply.status(201);
      return project;
    } catch (err: any) {
      reply.status(500);
      return { error: err.message };
    }
  });

  // GET /api/projects - List Projects
  fastify.get("/projects", async (request, reply) => {
    try {
      const projects = await engine.listProjects();
      return projects;
    } catch (err: any) {
      reply.status(500);
      return { error: err.message };
    }
  });

  // GET /api/projects/:projectId - Get Project
  fastify.get<{
    Params: {
      projectId: string;
    };
  }>("/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params;
    try {
      const project = await engine.getProject(projectId);
      if (!project) {
        reply.status(404);
        return { error: `Project not found: ${projectId}` };
      }
      return project;
    } catch (err: any) {
      reply.status(404);
      return { error: err.message };
    }
  });

  // GET /api/projects/:projectId/tree - Get Project Tree
  fastify.get<{
    Params: {
      projectId: string;
    };
  }>("/projects/:projectId/tree", async (request, reply) => {
    const { projectId } = request.params;
    try {
      const tree = await engine.getProjectTree(projectId);
      if (!tree) {
        reply.status(404);
        return { error: `Project tree not found: ${projectId}` };
      }
      return tree;
    } catch (err: any) {
      reply.status(500);
      return { error: err.message };
    }
  });

  // GET /api/projects/:projectId/events - Get Project Event Timeline
  fastify.get<{
    Params: {
      projectId: string;
    };
  }>("/projects/:projectId/events", async (request, reply) => {
    const { projectId } = request.params;
    try {
      const events = await engine.getStore().getProjectEvents(projectId);
      return events;
    } catch (err: any) {
      reply.status(500);
      return { error: err.message };
    }
  });

  // GET /api/projects/:projectId/progress - Get Real-Time Project Progress
  fastify.get<{
    Params: {
      projectId: string;
    };
  }>("/projects/:projectId/progress", async (request, reply) => {
    const { projectId } = request.params;
    try {
      const progress = await engine.refreshProjectProgress(projectId);
      const project = await engine.getProject(projectId);
      return { projectId, progress, status: project?.status };
    } catch (err: any) {
      reply.status(500);
      return { error: err.message };
    }
  });

  // GET /api/projects/:projectId/events/stream - Server-Sent Events (SSE)
  fastify.get<{
    Params: {
      projectId: string;
    };
  }>("/projects/:projectId/events/stream", async (request, reply) => {
    const { projectId } = request.params;

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");

    // Initial SSE heartbeat / connected message
    reply.raw.write(`: connected\n\n`);

    const unsubscribe = engine.subscribe(projectId, (event) => {
      try {
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {}
    });

    request.raw.on("close", () => {
      unsubscribe();
    });

    // Return a promise that does not resolve until connection closes
    return new Promise<void>((resolve) => {
      request.raw.on("close", () => resolve());
    });
  });

  // --- Epic Endpoints ---

  // POST /api/projects/:projectId/epics - Create Epic under Project
  fastify.post<{
    Params: {
      projectId: string;
    };
    Body: {
      id?: string;
      title: string;
      description?: string;
      priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    };
  }>("/projects/:projectId/epics", async (request, reply) => {
    const { projectId } = request.params;
    const body = request.body;
    if (!body || !body.title) {
      reply.status(400);
      return { error: "Missing required field: title is required." };
    }

    try {
      const epic = await engine.createEpic({
        ...body,
        projectId,
      });
      reply.status(201);
      return epic;
    } catch (err: any) {
      reply.status(500);
      return { error: err.message };
    }
  });

  // GET /api/projects/:projectId/epics - List Epics under Project
  fastify.get<{
    Params: {
      projectId: string;
    };
  }>("/projects/:projectId/epics", async (request, reply) => {
    const { projectId } = request.params;
    try {
      const epics = await engine.listEpics(projectId);
      return epics;
    } catch (err: any) {
      reply.status(500);
      return { error: err.message };
    }
  });

  // GET /api/epics/:epicId - Get Epic by ID
  fastify.get<{
    Params: {
      epicId: string;
    };
  }>("/epics/:epicId", async (request, reply) => {
    const { epicId } = request.params;
    try {
      const epic = await engine.getEpic(epicId);
      if (!epic) {
        reply.status(404);
        return { error: `Epic not found: ${epicId}` };
      }
      return epic;
    } catch (err: any) {
      reply.status(500);
      return { error: err.message };
    }
  });
};
