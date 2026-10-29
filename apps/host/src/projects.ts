import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Project } from "@codexphone/shared";
import { isRecord } from "@codexphone/shared";
import { HttpError, normalizedPath } from "./security.js";

type RegisteredProject = Project & { path: string };

export function projectId(projectPath: string): string {
  let hash = 0;
  for (const char of normalizedPath(projectPath)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36).padStart(8, "0").slice(0, 12);
}

export function initialProjects(): RegisteredProject[] {
  const projects = new Map<string, RegisteredProject>();
  for (const entry of (process.env.CODEXPHONE_PROJECTS || "").split(";").map((value) => value.trim()).filter(Boolean)) {
    const split = entry.indexOf("=");
    const directory = (split > 0 ? entry.slice(split + 1) : entry).trim();
    if (!directory) continue;
    const projectPath = path.resolve(directory);
    const id = projectId(projectPath);
    projects.set(id, { id, name: (split > 0 ? entry.slice(0, split).trim() : "") || path.basename(projectPath) || projectPath, path: projectPath, canStart: true });
  }
  if (!projects.size) {
    const projectPath = path.resolve(process.env.CODEXPHONE_DEFAULT_PROJECT || process.cwd());
    const id = projectId(projectPath);
    projects.set(id, { id, name: path.basename(projectPath) || projectPath, path: projectPath, canStart: true });
  }
  return [...projects.values()];
}

export async function validateProjectDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value.trim())) {
    throw new HttpError(400, "请输入电脑上项目目录的完整绝对路径");
  }
  const directory = path.resolve(value.trim());
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error("Not a directory");
  } catch {
    throw new HttpError(400, "项目目录不存在或无法访问，请填写电脑上的现有文件夹");
  }
  return directory;
}

export class ProjectStore {
  private projects: RegisteredProject[] = initialProjects();
  private changes: Promise<unknown> = Promise.resolve();

  constructor(readonly directory: string) {}

  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(path.join(this.directory, "projects.json"), "utf8"));
      if (!isRecord(value) || !Array.isArray(value.projects)) throw new Error("Invalid project store");
      const projects = new Map<string, RegisteredProject>();
      for (const entry of value.projects) {
        if (!isRecord(entry) || typeof entry.path !== "string" || !path.isAbsolute(entry.path) || typeof entry.name !== "string" || !entry.name.trim()) throw new Error("Invalid project");
        const projectPath = path.resolve(entry.path);
        const id = projectId(projectPath);
        if (projects.has(id)) throw new Error("Duplicate project");
        projects.set(id, { id, name: entry.name, path: projectPath, canStart: true });
      }
      this.projects = [...projects.values()];
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) throw new Error("Could not read project store; preserve projects.json and fix it before restarting.");
    }
  }

  list(): RegisteredProject[] { return this.projects.map((project) => ({ ...project })); }

  private change<T>(action: () => Promise<T>): Promise<T> {
    const next = this.changes.catch(() => {}).then(action);
    this.changes = next;
    return next;
  }

  upsert(body: Record<string, unknown>, id?: string): Promise<RegisteredProject> {
    return this.change(async () => {
      if (id && !this.projects.some((project) => project.id === id)) throw new HttpError(404, "项目已被移除，请刷新列表");
      const projectPath = await validateProjectDirectory(body.path);
      if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length > 100)) throw new HttpError(400, "项目名称不能超过 100 个字符");
      const nextId = projectId(projectPath);
      if (this.projects.some((project) => project.id === nextId && project.id !== id)) throw new HttpError(409, "这个目录已经登记，请直接选择或编辑现有项目");
      const project = { id: nextId, name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : path.basename(projectPath) || projectPath, path: projectPath, canStart: true };
      const projects = id ? this.projects.map((entry) => entry.id === id ? project : entry) : [...this.projects, project];
      await this.save(projects);
      this.projects = projects;
      return { ...project };
    });
  }

  remove(id: string): Promise<void> {
    return this.change(async () => {
      if (!this.projects.some((project) => project.id === id)) throw new HttpError(404, "项目已被移除，请刷新列表");
      const projects = this.projects.filter((project) => project.id !== id);
      await this.save(projects);
      this.projects = projects;
    });
  }

  private async save(projects: RegisteredProject[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `projects-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ projects: projects.map(({ name, path: directory }) => ({ name, path: directory })) }, null, 2), { mode: 0o600 });
    await rename(temporary, path.join(this.directory, "projects.json"));
  }
}
