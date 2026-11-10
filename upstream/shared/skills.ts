export type SkillSource = "hob" | "lore" | "common";
export type SkillImportSource = "pi" | "claude" | "codex";

export interface SkillView {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  content: string;
  enabled: boolean;
  overridden: boolean;
}

export interface SkillsView {
  skills: SkillView[];
  loreActive: boolean;
  loreUrl: string | null;
  /** Lore 目录没取到的原因；其他技能照常列出。 */
  loreError?: string;
}

export interface ImportSkill {
  id: string;
  name: string;
  description: string;
  exists: boolean;
}

export interface SkillImportView {
  found: boolean;
  skills: ImportSkill[];
  skipped: string[];
}

export interface SkillImportResult {
  imported: string[];
  skipped: string[];
  errors: string[];
}

/**
 * 助手自己沉淀的技能：HOB_HOME/assistants/<id>/skills/<name>/SKILL.md（加 scripts/、references/），
 * 元数据在 assistants/<id>/skills/skills.json。只有这个助手的任务加载。
 */
export interface AssistantSkill {
  name: string; // 目录名：小写字母、数字、连字符
  title: string; // 界面上显示的名字，如「每周周报」
  description: string; // 一句话：什么时候用
  path: string; // SKILL.md 的绝对路径（预览用）
  version: number; // 每次修补 +1，旧版在 skills/<name>/.history/<版本>/
  createdAt: string;
  updatedAt: string;
  fromJobId?: string; // 最近一次从哪个任务沉淀或修补
  uses: number; // 被任务读过几次
  lastUsedAt?: string;
  enabled: boolean;
}
