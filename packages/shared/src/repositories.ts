export interface GitHubRepository {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface WorkspaceRepository {
  id: string;
  workspaceId: string;
  repositoryId: number;
  fullName: string;
  ref: string;
  private: boolean;
  createdAt: string;
}

export interface SessionRepository {
  bindingId: string;
  repositoryId: number;
  fullName: string;
  ref: string;
  commit: string;
  path: string;
}

// Extraction limits are aggregate across all repositories in one session.
export const repositoryLimits = {
  repositories: 5,
  archiveBytes: 8 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  // Real repositories vendor prebuilt binaries (multi-MiB dylibs/tools); the aggregate bounds above still apply.
  fileBytes: 8 * 1024 * 1024,
  entries: 10000,
} as const;
