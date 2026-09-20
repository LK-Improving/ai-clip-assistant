import { z } from 'zod';
import type { Project } from './project';
import { ProjectSchema } from './project';
import { migrateProject } from './migrate';

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

export class ProjectValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`工程校验失败：${issues.length} 处问题\n${issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`).join('\n')}`);
    this.name = 'ProjectValidationError';
    this.issues = issues;
  }
}

export function formatIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

export type ValidateResult =
  | { success: true; data: Project }
  | { success: false; issues: ValidationIssue[] };

/** 校验任意输入（不会抛异常，适合 UI 层与 IPC 边界） */
export function validateProject(input: unknown): ValidateResult {
  const result = ProjectSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: formatIssues(result.error) };
}

/** 校验任意输入，失败直接抛 ProjectValidationError */
export function parseProject(input: unknown): Project {
  const result = ProjectSchema.safeParse(input);
  if (!result.success) throw new ProjectValidationError(formatIssues(result.error));
  return result.data;
}

export function isProject(input: unknown): input is Project {
  return ProjectSchema.safeParse(input).success;
}

/**
 * 读盘入口：先按 schemaVersion 迁移到当前版本，再校验。
 * 所有外部工程文件（磁盘 / AI 输出 / IPC）都必须经过这里。
 */
export function loadProject(raw: unknown): Project {
  return parseProject(migrateProject(raw));
}
