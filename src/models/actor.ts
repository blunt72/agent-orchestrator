/**
 * Actor / Owner Model for AgentHub V0.3
 * Unifies Human team members and AI Agents into a single collaborative entity model.
 */

export type ActorType = "HUMAN" | "AGENT";

export interface Actor {
  id: string;
  type: ActorType;
  name: string;
  role?: string;
  capabilities?: string[];
  enabled: boolean;
}

export const DEFAULT_SYSTEM_ACTORS: Actor[] = [
  {
    id: "codex",
    type: "AGENT",
    name: "Codex",
    role: "Developer",
    capabilities: ["code_generation", "refactoring", "debugging", "test_writing"],
    enabled: true,
  },
  {
    id: "gemini",
    type: "AGENT",
    name: "Gemini",
    role: "Reviewer",
    capabilities: ["code_review", "architecture_analysis", "test_gap_analysis"],
    enabled: true,
  },
  {
    id: "user",
    type: "HUMAN",
    name: "Default Human User",
    role: "Project Owner",
    capabilities: ["decision_making", "acceptance", "domain_expertise"],
    enabled: true,
  },
];
