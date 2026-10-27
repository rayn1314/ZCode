import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

const rootsById = (projects: readonly { id: string; roots: { rootPath: string }[] }[]) =>
  new Map(projects.map((project) => [project.id, project.roots.map((root) => root.rootPath)]));

// 编辑路径（saveProject({id, roots})）此前不校验同根唯一：把根改到另一个活项目占用的
// 同一 root 集合会重新造出同根重复。同根唯一由写事务保证，判据与新建/恢复共用
// claimedRootsProject（root 集合完全相同、软删项目不参与、自身 id 排除）。
describe("project root claimed on the edit path", () => {
  it("rejects editing a project onto the roots another live project owns", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const first = repo.saveProject({ roots: ["/x"], name: "First" });
    const second = repo.saveProject({ roots: ["/y"], name: "Second" });
    expect(() => repo.saveProject({ id: first.id, roots: ["/y"] })).toThrow("project.root-claimed");
    // 拒绝发生在写事务内：两边 roots 都不被改写，也不新增第三行。
    expect(rootsById(repo.readTree().projects)).toEqual(
      new Map([
        [second.id, ["/y"]],
        [first.id, ["/x"]],
      ]),
    );
  });

  it("rejects growing or shrinking a root set into another live project's exact set", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const shared = repo.saveProject({ roots: ["/a", "/b"], name: "Shared" });
    const other = repo.saveProject({ roots: ["/a", "/b", "/c"], name: "Other" });
    expect(() => repo.saveProject({ id: other.id, roots: ["/a", "/b"] })).toThrow(
      "project.root-claimed",
    );
    expect(() => repo.saveProject({ id: shared.id, roots: ["/a", "/b", "/c"] })).toThrow(
      "project.root-claimed",
    );
    // 多 root 项目只共享部分目录仍是合法组织态，编辑到部分重合不触发拒绝。
    expect(
      repo.saveProject({ id: shared.id, roots: ["/a"] }).roots.map((root) => root.rootPath),
    ).toEqual(["/a"]);
    expect(rootsById(repo.readTree().projects)).toEqual(
      new Map([
        [other.id, ["/a", "/b", "/c"]],
        [shared.id, ["/a"]],
      ]),
    );
  });

  it("allows editing a project's own roots, reordering its own roots and renaming", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const own = repo.saveProject({ roots: ["/a", "/b"], name: "Mine" });
    const roots = (project: { roots: { rootPath: string }[] }) =>
      project.roots.map((root) => root.rootPath);
    expect(roots(repo.saveProject({ id: own.id, roots: ["/b", "/a"] }))).toEqual(["/b", "/a"]);
    expect(roots(repo.saveProject({ id: own.id, roots: ["/a", "/b", "/c"] }))).toEqual([
      "/a",
      "/b",
      "/c",
    ]);
    expect(roots(repo.saveProject({ id: own.id, roots: ["/a", "/b"] }))).toEqual(["/a", "/b"]);
    expect(repo.saveProject({ id: own.id, name: "Renamed", pinned: true })).toMatchObject({
      id: own.id,
      name: "Renamed",
      pinned: true,
    });
    expect(roots(repo.readTree().projects[0]!)).toEqual(["/a", "/b"]);
  });

  it("keeps the same-root duplicates already in the database editable", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const live = repo.saveProject({ roots: ["/srv/repos"], name: "repos" });
    // 同为活项目的历史重复数据（写入侧只约束新写入，本轮不自动收敛）：
    // 改名/置顶必须继续可用，否则用户再没有别的办法区分它们。
    db.exec(`INSERT INTO projects(project_id,host_id,name,position,deleted,created_at,updated_at)
      VALUES('legacy-dup','local','repos (2)',-5,0,0,0);
      INSERT INTO project_roots(project_id,root_path,position,is_primary)
      VALUES('legacy-dup','/srv/repos',0,1);`);
    expect(repo.saveProject({ id: "legacy-dup", name: "repos (2)", pinned: true })).toMatchObject({
      id: "legacy-dup",
      pinned: true,
    });
    expect(repo.saveProject({ id: live.id, name: "repos renamed" }).name).toBe("repos renamed");
  });

  it("keeps the new-project adoption behaviour and does not let remote projects bypass the rule", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const existing = repo.saveProject({ roots: ["/same"], name: "Existing" });
    const count = () =>
      Number(
        (db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count,
      );
    const before = count();
    expect(repo.saveProject({ roots: ["/same"], name: "Second" }).id).toBe(existing.id);
    expect(count()).toBe(before);
    // 远端项目根本来不可变（project.remote-root-immutable）；新增的同根校验不给它放行。
    db.exec("INSERT INTO hosts(host_id,kind) VALUES ('remote:server:remote','server')");
    const remote = port.repository(db, "remote:server:remote");
    const remoteFirst = remote.saveProject({ roots: ["/a"], name: "First" });
    remote.saveProject({ roots: ["/b"], name: "Second" });
    expect(() => remote.saveProject({ id: remoteFirst.id, roots: ["/b"] })).toThrow(
      "project.remote-root-immutable",
    );
  });
});
