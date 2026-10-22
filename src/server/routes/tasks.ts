import { FastifyPluginAsync } from "fastify";
import { TaskEngine } from "../../tasks/task-engine.js";
import { CreateTaskInput, TaskPriority, TaskStatus, TaskOwnerType } from "../../tasks/task.js";
import { ClaimTaskInput, TaskClaimError } from "../../tasks/task-claim.js";
import { TaskExecutionBusyError } from "../../tasks/task-execution.js";

export interface TaskRouteOptions {
  engine: TaskEngine;
}

export const taskRoutes: FastifyPluginAsync<TaskRouteOptions> = async (fastify, opts) => {
  const { engine } = opts;

  // POST /api/tasks - Create Task
  fastify.post<{
    Body: CreateTaskInput;
  }>("/tasks", async (request, reply) => {
    const input = request.body;
    if (!input || !input.projectId || !input.title) {
      reply.status(400);
      return { error: "Missing required fields: projectId and title are mandatory." };
    }

    try {
      const task = await engine.createTask(input);
      reply.status(201);
      return task;
    } catch (err: any) {
      reply.status(400);
      return { error: err.message };
    }
  });

  // GET /api/tasks - List Tasks
  fastify.get<{
    Querystring: {
      projectId?: string;
      epicId?: string;
      status?: TaskStatus;
    };
  }>("/tasks", async (request, reply) => {
    const { projectId, epicId, status } = request.query;
    try {
      const tasks = await engine.listTasks({ projectId, epicId, status });
      return tasks;
    } catch (err: any) {
      reply.status(500);
      return { error: err.message };
    }
  });

  // GET /api/tasks/:taskId - Get Task
  fastify.get<{
    Params: {
      taskId: string;
    };
  }>("/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params;
    try {
      const task = await engine.getTask(taskId);
      if (!task) {
        reply.status(404);
        return { error: `Task not found: ${taskId}` };
      }
      return task;
    } catch (err: any) {
      reply.status(404);
      return { error: err.message };
    }
  });

  // POST /api/tasks/:taskId/run - Run Task
  fastify.post<{
    Params: {
      taskId: string;
    };
  }>("/tasks/:taskId/run", async (request, reply) => {
    const { taskId } = request.params;
    try {
      const updated = await engine.runTask(taskId);
      return updated;
    } catch (err: any) {
      if (err instanceof TaskExecutionBusyError) {
        return reply.status(409).send({ error: err.message, code: err.code });
      }
      reply.status(400);
      return { error: err.message };
    }
  });

  // POST /api/tasks/:taskId/cancel - Cancel Task
  fastify.post<{
    Params: {
      taskId: string;
    };
  }>("/tasks/:taskId/cancel", async (request, reply) => {
    const { taskId } = request.params;
    try {
      await engine.cancelTask(taskId);
      const updated = await engine.getTask(taskId);
      return updated;
    } catch (err: any) {
      reply.status(400);
      return { error: err.message };
    }
  });

  // POST /api/tasks/:taskId/resume - Resume Task
  fastify.post<{
    Params: {
      taskId: string;
    };
  }>("/tasks/:taskId/resume", async (request, reply) => {
    const { taskId } = request.params;
    try {
      const updated = await engine.resumeTask(taskId);
      return updated;
    } catch (err: any) {
      if (err instanceof TaskExecutionBusyError) {
        return reply.status(409).send({ error: err.message, code: err.code });
      }
      reply.status(400);
      return { error: err.message };
    }
  });

  // POST /api/tasks/:taskId/claim - Compare-and-set ownership
  fastify.post<{ Params: { taskId: string }; Body: ClaimTaskInput }>(
    "/tasks/:taskId/claim", async (request, reply) => {
      try {
        return await engine.claimTask(request.params.taskId, request.body);
      } catch (error: unknown) {
        if (error instanceof TaskClaimError) {
          return reply.status(error.statusCode).send({ error: error.message, code: error.code });
        }
        throw error;
      }
    },
  );

  // Administrative reassignment remains separate from compare-and-set claiming.
  fastify.post<{
    Params: {
      taskId: string;
    };
    Body: {
      ownerId: string;
      ownerType?: TaskOwnerType;
      role?: string;
    };
  }>("/tasks/:taskId/assign", async (request, reply) => {
    const { taskId } = request.params;
    const body = request.body;
    if (!body || !body.ownerId) {
      reply.status(400);
      return { error: "Missing required field: ownerId is mandatory." };
    }

    try {
      const updated = await engine.assignTask(taskId, body);
      return updated;
    } catch (err: any) {
      reply.status(400);
      return { error: err.message };
    }
  });

  // POST /api/tasks/:taskId/start - Human Start Task
  fastify.post<{
    Params: {
      taskId: string;
    };
    Body?: {
      userId?: string;
    };
  }>("/tasks/:taskId/start", async (request, reply) => {
    const { taskId } = request.params;
    const userId = request.body?.userId || "user";
    try {
      const updated = await engine.startHumanTask(taskId, userId);
      return updated;
    } catch (err: any) {
      reply.status(400);
      return { error: err.message };
    }
  });

  // POST /api/tasks/:taskId/complete - Human Complete Task
  fastify.post<{
    Params: {
      taskId: string;
    };
    Body?: {
      userId?: string;
      summary?: string;
    };
  }>("/tasks/:taskId/complete", async (request, reply) => {
    const { taskId } = request.params;
    const userId = request.body?.userId || "user";
    const summary = request.body?.summary;
    try {
      const updated = await engine.completeHumanTask(taskId, userId, summary);
      return updated;
    } catch (err: any) {
      reply.status(400);
      return { error: err.message };
    }
  });

  // POST /api/tasks/:taskId/respond - Respond to NEED_USER
  fastify.post<{
    Params: {
      taskId: string;
    };
    Body: {
      message: string;
      userId?: string;
    };
  }>("/tasks/:taskId/respond", async (request, reply) => {
    const { taskId } = request.params;
    const body = request.body;
    if (!body || !body.message) {
      reply.status(400);
      return { error: "Missing required field: message is mandatory." };
    }

    try {
      const updated = await engine.respondToNeedUser(taskId, body.message, body.userId || "user");
      return updated;
    } catch (err: any) {
      reply.status(400);
      return { error: err.message };
    }
  });

  // POST /api/tasks/:taskId/block - Block Task
  fastify.post<{
    Params: {
      taskId: string;
    };
    Body?: {
      reason?: string;
    };
  }>("/tasks/:taskId/block", async (request, reply) => {
    const { taskId } = request.params;
    const reason = request.body?.reason;
    try {
      const updated = await engine.blockTask(taskId, reason);
      return updated;
    } catch (err: any) {
      reply.status(400);
      return { error: err.message };
    }
  });

  // POST /api/tasks/:taskId/unblock - Unblock Task
  fastify.post<{
    Params: {
      taskId: string;
    };
  }>("/tasks/:taskId/unblock", async (request, reply) => {
    const { taskId } = request.params;
    try {
      const updated = await engine.unblockTask(taskId);
      return updated;
    } catch (err: any) {
      reply.status(400);
      return { error: err.message };
    }
  });

  // GET /api/tasks/:taskId/events - Get Task Events
  fastify.get<{
    Params: {
      taskId: string;
    };
  }>("/tasks/:taskId/events", async (request, reply) => {
    const { taskId } = request.params;
    try {
      const events = await engine.getStore().getEvents(taskId);
      return events;
    } catch (err: any) {
      reply.status(500);
      return { error: err.message };
    }
  });

  // GET /api/tasks/:taskId/tree - Get Task Subtree
  fastify.get<{
    Params: {
      taskId: string;
    };
  }>("/tasks/:taskId/tree", async (request, reply) => {
    const { taskId } = request.params;
    try {
      const tree = await engine.getStore().getTree(taskId);
      if (!tree) {
        reply.status(404);
        return { error: `Task tree not found: ${taskId}` };
      }
      return tree;
    } catch (err: any) {
      reply.status(404);
      return { error: err.message };
    }
  });

  // GET /api/tasks/:taskId/traceability - Get Task Traceability
  fastify.get<{
    Params: {
      taskId: string;
    };
  }>("/tasks/:taskId/traceability", async (request, reply) => {
    const { taskId } = request.params;
    try {
      const traceability = await engine.getTaskTraceability(taskId);
      if (!traceability) {
        reply.status(404);
        return { error: `Traceability not found for task: ${taskId}` };
      }
      return traceability;
    } catch (err: any) {
      reply.status(500);
      return { error: err.message };
    }
  });
};
