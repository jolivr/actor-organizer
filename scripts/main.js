/* Actor Alphabetizer (Foundry VTT v13)
 * Features:
 * - Create A–Z folders (optionally all letters even if empty)
 * - Optional grouping by actor type (type folder -> letter folders)
 * - Choose parent folder (or Root)
 * - Optional include subfolders (scope which actors are affected)
 * - Dropdown shows breadcrumb paths + actor counts (direct/withSubfolders)
 * - De-dup breadcrumb labels by appending short id suffix
 */

Hooks.once("init", () => {
  // Expose a simple API so you can call it from a Macro.
  const mod = game.modules.get("actor-alphabetizer");
  if (mod) mod.api = { open: () => openAlphabetizerDialog() };
});

function normalizeLetter(name) {
  const s = (name ?? "").trim();
  const m = s.match(/[A-Za-z]/); // first alphabetic char anywhere in the string
  return m ? m[0].toUpperCase() : null;
}

function shortId(id) {
  return String(id ?? "").slice(-4);
}

function folderBreadcrumb(folder) {
  const parts = [];
  let cur = folder;
  while (cur) {
    parts.push(cur.name);
    cur = cur.folder;
  }
  return parts.reverse().join(" / ");
}

function buildFolderChildrenMap(actorFolders) {
  const children = new Map(); // parentId (or null) -> Folder[]
  for (const f of actorFolders) {
    const pid = f.folder?.id ?? null;
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid).push(f);
  }
  return children;
}

function buildDescendantsMemo(actorFolders) {
  const children = buildFolderChildrenMap(actorFolders);
  const memo = new Map(); // folderId -> Set(folderId + descendants)

  const dfs = (folderId) => {
    if (memo.has(folderId)) return memo.get(folderId);
    const set = new Set([folderId]);
    const kids = children.get(folderId) ?? [];
    for (const k of kids) {
      for (const x of dfs(k.id)) set.add(x);
    }
    memo.set(folderId, set);
    return set;
  };

  for (const f of actorFolders) dfs(f.id);
  return memo;
}

function isDescendantFolder(folder, ancestorId) {
  let cur = folder;
  while (cur?.folder) {
    if (cur.folder.id === ancestorId) return true;
    cur = cur.folder;
  }
  return false;
}

function actorInScope(actor, parentId, includeSubfolders) {
  // parentId null = Root scope = include all actors
  if (parentId == null) return true;

  // Actor is in selected folder?
  if (actor.folder?.id === parentId) return true;

  if (!includeSubfolders) return false;

  // includeSubfolders: actor must be in any descendant folder
  const f = actor.folder;
  if (!f) return false;
  return isDescendantFolder(f, parentId);
}

function countActorsForFolder(folderId, actors, descendantsMemo) {
  const direct = actors.filter(a => a.folder?.id === folderId).length;
  const descSet = descendantsMemo.get(folderId) ?? new Set([folderId]);
  const withSubfolders = actors.filter(a => a.folder && descSet.has(a.folder.id)).length;
  return { direct, withSubfolders };
}

async function openAlphabetizerDialog() {
  if (!game.user.isGM) {
    ui.notifications.warn("GM permissions required.");
    return;
  }

  // Build dropdown list: Root + all Actor folders (breadcrumb paths + counts + de-dupe)
  const actorFolders = game.folders.filter(f => f.type === "Actor");
  const allActors = game.actors.contents;

  const descendantsMemo = buildDescendantsMemo(actorFolders);

  const raw = actorFolders.map(f => {
    const crumb = folderBreadcrumb(f);
    const { direct, withSubfolders } = countActorsForFolder(f.id, allActors, descendantsMemo);
    return { id: f.id, crumb, direct, withSubfolders };
  });

  const countsByCrumb = new Map();
  for (const r of raw) countsByCrumb.set(r.crumb, (countsByCrumb.get(r.crumb) ?? 0) + 1);

  const options = [
    { id: "root", name: `Root (all Actors) (${allActors.length})` },
    ...raw
      .map(r => {
        const isDup = (countsByCrumb.get(r.crumb) ?? 0) > 1;
        const suffix = isDup ? ` [${shortId(r.id)}]` : "";
        const countLabel = `${r.direct}/${r.withSubfolders}`; // direct/withSubfolders
        return { id: r.id, name: `${r.crumb}${suffix} (${countLabel})` };
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  ];

  const content = `
  <form class="flexcol" style="gap: 0.6rem;">
    <div class="form-group">
      <label>Create all A–Z folders even if empty?</label>
      <input type="checkbox" name="createAllLetters" />
    </div>

    <div class="form-group">
      <label>Group by actor type first?</label>
      <input type="checkbox" name="groupByType" />
      <p class="notes">Creates: Parent → (type folder) → A–Z folders.</p>
    </div>

    <div class="form-group">
      <label>Group in which folder?</label>
      <select name="parentFolder">
        ${options.map(o => `<option value="${o.id}">${o.name}</option>`).join("")}
      </select>
      <p class="notes">Counts shown as direct/withSubfolders. Root sorts all world Actors.</p>
    </div>

    <div class="form-group">
      <label>Include subfolders in scope?</label>
      <input type="checkbox" name="includeSubfolders" checked />
      <p class="notes">If a parent folder is chosen, this controls whether Actors in descendant folders are included.</p>
    </div>
  </form>`;

  const dlg = new foundry.applications.api.DialogV2({
    window: { title: "Actor Alphabetizer (v13)", resizable: true },
    content,
    buttons: [
      {
        action: "run",
        label: "Run",
        icon: "fa-solid fa-play",
        default: true,
        callback: async (event, button, dialog) => {
          const form = dialog.element.querySelector("form");
          const fd = new FormData(form);

          const createAllLetters = fd.get("createAllLetters") === "on";
          const groupByType = fd.get("groupByType") === "on";
          const includeSubfolders = fd.get("includeSubfolders") === "on";

          const parentFolderRaw = String(fd.get("parentFolder") ?? "root");
          const parentFolderId = parentFolderRaw === "root" ? null : parentFolderRaw;

          await runAlphabetizer({
            createAllLetters,
            groupByType,
            parentFolderId,
            includeSubfolders
          });
        }
      },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
    ]
  });

  dlg.render(true);
}

async function runAlphabetizer({ createAllLetters, groupByType, parentFolderId, includeSubfolders }) {
  // 1) Determine which Actors are affected
  const actors = game.actors.contents.filter(a => actorInScope(a, parentFolderId, includeSubfolders));

  if (!actors.length) {
    ui.notifications.warn("No Actors found in the selected scope.");
    return;
  }

  // 2) Determine letters to create
  const letters = createAllLetters
    ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
    : Array.from(new Set(actors.map(a => normalizeLetter(a.name)).filter(Boolean))).sort();

  if (!letters.length) {
    ui.notifications.warn("No Actors had a usable A–Z starting letter.");
    return;
  }

  // Helpers: find or create direct child folders under a specific parent
  const findChildFolder = (name, parentId) => {
    return game.folders.find(f =>
      f.type === "Actor" &&
      f.name === name &&
      (parentId == null ? f.folder == null : f.folder?.id === parentId)
    ) ?? null;
  };

  const ensureFolder = async (name, parentId) => {
    const existing = findChildFolder(name, parentId);
    if (existing) return existing.id;

    const [created] = await Folder.createDocuments([{ name, type: "Actor", folder: parentId }]);
    return created.id;
  };

  // 3) Build destination structure
  const typeFolderIds = new Map();   // type -> folderId
  const letterFolderIds = new Map(); // key -> folderId
  // key = groupByType ? `${type}::${letter}` : `::${letter}`

  const types = groupByType
    ? Array.from(new Set(actors.map(a => String(a.type)))).sort()
    : [null];

  // Ensure type folders
  if (groupByType) {
    for (const t of types) {
      const typeFolderId = await ensureFolder(String(t), parentFolderId);
      typeFolderIds.set(String(t), typeFolderId);
    }
  }

  // Ensure A–Z folders in the right place
  for (const t of types) {
    const baseParentId = groupByType ? typeFolderIds.get(String(t)) : parentFolderId;
    for (const L of letters) {
      const id = await ensureFolder(L, baseParentId);
      const key = groupByType ? `${String(t)}::${L}` : `::${L}`;
      letterFolderIds.set(key, id);
    }
  }

  // 4) Move Actors
  const updates = [];
  for (const a of actors) {
    const L = normalizeLetter(a.name);
    if (!L) continue;

    const key = groupByType ? `${String(a.type)}::${L}` : `::${L}`;
    const destFolderId = letterFolderIds.get(key);
    if (!destFolderId) continue;

    if (a.folder?.id === destFolderId) continue;
    updates.push({ _id: a.id, folder: destFolderId });
  }

  if (!updates.length) {
    ui.notifications.info("Nothing to move — Actors already organized.");
    return;
  }

  await Actor.updateDocuments(updates);

  ui.notifications.info(
    `Alphabetizer: moved ${updates.length} Actor(s). ` +
    `${groupByType ? "Grouped by type → letter." : "Grouped by letter."}`
  );
}
