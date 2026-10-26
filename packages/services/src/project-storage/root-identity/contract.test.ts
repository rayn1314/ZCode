import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

// 同根两个活项目会让入口/任务归属无法判定身份（现场：软删项目与活项目同根），
// 因此新建同根目录直接采纳已有活项目，恢复则必须拒绝。
describe("project root identity contract", () => {
  it("adopts the live project already owning the same roots instead of inserting a duplicate", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    db.exec("INSERT INTO hosts(host_id,kind) VALUES ('remote:server:dup','server')");
    const repo = port.repository(db, "remote:server:dup");
    const first = repo.saveProject({ name: "repos", roots: ["/srv/repos"] });
    const count = (table: string) =>
      Number(
        (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
      );
    const before = { projects: count("projects"), roots: count("project_roots") };
    const adopted = repo.saveProject({ name: "repos (2)", roots: ["/srv/repos"] });
    expect(adopted).toMatchObject({ id: first.id, name: "repos", deleted: false });
    expect({ projects: count("projects"), roots: count("project_roots") }).toEqual(before);
    // 多 root 项目只共享部分目录仍是合法组织态，不触发采纳。
    const local = port.repository(db);
    const shared = local.saveProject({ roots: ["/local", "/shared"] });
    expect(local.saveProject({ roots: ["/shared", "/other"] }).id).not.toBe(shared.id);
  });

  it("rejects restoring a deleted project whose roots a live project already owns", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    db.exec("INSERT INTO hosts(host_id,kind) VALUES ('remote:server:dup','server')");
    const repo = port.repository(db, "remote:server:dup");
    const live = repo.saveProject({ name: "repos", roots: ["/srv/repos"] });
    db.exec(
      `INSERT INTO projects(project_id,host_id,name,position,deleted,created_at,updated_at)
       VALUES('legacy-deleted','remote:server:dup','repos (2)',-1,1,0,0);
       INSERT INTO project_roots(project_id,root_path,position,is_primary)
       VALUES('legacy-deleted','/srv/repos',0,1);`,
    );
    expect(() =>
      repo.saveProject({ restoreProjectId: "legacy-deleted", roots: ["/srv/repos"] }),
    ).toThrow("project.restore-root-claimed");
    expect(live.deleted).toBe(false);
    // 该根没有活项目占用时，恢复仍旧照常生效。
    repo.deleteProject(live.id);
    expect(
      repo.saveProject({ restoreProjectId: "legacy-deleted", roots: ["/srv/repos"] }).deleted,
    ).toBe(false);
  });
});
