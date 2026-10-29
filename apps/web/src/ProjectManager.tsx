import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleAlert, FolderGit2, LoaderCircle, Plus, X } from "lucide-react";
import type { Project } from "@codexphone/shared";
import { api } from "./api";

interface Props {
  projects: Project[];
  onSaved: (project?: Project) => Promise<void>;
  onClose: () => void;
}

export function ProjectManager({ projects, onSaved, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const edit = (project: Project | null) => {
    setEditing(project); setName(project?.name || ""); setDirectory(project?.path || ""); setError(null);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const { project } = await api.saveProject({ name: name.trim(), path: directory.trim() }, editing?.canStart ? editing.id : undefined);
      await onSaved(project);
      edit(project);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "项目保存失败，请重试"); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!editing?.canStart || busy) return;
    setBusy(true); setError(null);
    try {
      await api.removeProject(editing.id);
      await onSaved();
      edit(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "项目移除失败，请重试"); }
    finally { setBusy(false); }
  };

  return <dialog ref={dialog} className="project-manager" aria-labelledby="project-manager-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="project-manager-header"><div><h2 id="project-manager-title">管理项目</h2><p>登记电脑上的项目目录，即可从手机启动任务。</p></div><button type="button" className="icon-button" aria-label="关闭项目管理" disabled={busy} onClick={onClose}><X size={20} /></button></header>
    <div className="project-manager-list" aria-label="已发现的项目">
      {projects.map((project) => <button type="button" key={project.id} className={`project-manager-row ${editing?.id === project.id ? "active" : ""}`} disabled={busy} onClick={() => edit(project)}><FolderGit2 size={18} /><span><strong>{project.name}</strong><small>{project.path}</small></span><span className="project-state">{project.canStart ? "编辑" : "启用"}</span></button>)}
    </div>
    <button type="button" className="project-add" disabled={busy} onClick={() => edit(null)}><Plus size={17} />新增项目</button>
    <form className="project-form" onSubmit={save}>
      <h3>{editing ? editing.canStart ? "编辑项目" : "启用此项目" : "新增项目"}</h3>
      <label>项目名称<input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} maxLength={100} placeholder="留空时使用文件夹名称" autoComplete="off" /></label>
      <label>电脑上的目录<input value={directory} onChange={(event) => setDirectory(event.target.value)} disabled={busy} placeholder="D:\\path\\to\\project" required autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
      <p className="project-form-note">填写电脑上的完整路径；保存后立即生效，重启后仍会保留。移除仅取消启动权限，不删除文件或历史对话。</p>
      {error && <p className="error-note" role="alert"><CircleAlert size={16} />{error}</p>}
      <div className="project-form-actions">{editing?.canStart && <button type="button" className="project-remove" disabled={busy} onClick={() => void remove()}>移除项目</button>}<button type="submit" className="primary-button" disabled={busy || !directory.trim()}>{busy ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />}{editing?.canStart ? "保存修改" : "保存并启用"}</button></div>
    </form>
  </dialog>;
}
