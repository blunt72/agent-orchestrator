import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectStore } from "../../src/projects/project-store.js";
import { Epic } from "../../src/models/epic.js";

describe("EpicStore Unit Tests", () => {
  let tempDir: string;
  let store: ProjectStore;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `agenthub-epic-store-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    store = new ProjectStore(tempDir);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("saves, retrieves, and lists epics by project", async () => {
    const epic1: Epic = {
      id: "EPIC-AUTH",
      projectId: "P1",
      title: "Authentication Module",
      description: "Login and token validation",
      status: "TODO",
      progress: 0,
      priority: "HIGH",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const epic2: Epic = {
      id: "EPIC-PAY",
      projectId: "P2",
      title: "Payment Module",
      status: "DOING",
      progress: 40,
      priority: "CRITICAL",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.saveEpic(epic1);
    await store.saveEpic(epic2);

    const fetched = await store.getEpic("EPIC-AUTH");
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe("Authentication Module");
    expect(fetched?.priority).toBe("HIGH");

    const p1Epics = await store.listEpics("P1");
    expect(p1Epics.length).toBe(1);
    expect(p1Epics[0].id).toBe("EPIC-AUTH");

    const allEpics = await store.listEpics();
    expect(allEpics.length).toBe(2);
  });
});
