/* ---------------- ATO-1146: drag a chat into a project ----------------
   Loaded after chat-folders.js and chat-projects.js; declares only, and reads
   their globals (FOLDER_DRAG_TYPE, FOLDERS, PROJECTS, projectAny) and
   renderer.js's (act, toast) at call time.

   A chat row (draggable, renderer.js chatRow) is dragged with HTML5 drag and
   drop. As in the ChatGPT and Claude apps, the whole project takes it: its
   header and the chats drawn under it, not only the header line. The Chats
   list takes it back out of its project. The header of the group under the
   pointer is lit while the chat is over it. A drop goes through the same
   `fput:<project>:<chat>` act the row menu's "Move to project" uses
   (renderer.js, chat-projects.js projectPutChat), so pinned chats, chat
   folders and the projects store behave the same either way. The keyboard
   way stays that menu.

   A drop on the project the chat is already in does nothing. A drop that
   moves it says where it went: a folded project shows nothing else. */

/** What a drop of chat `sid` on project `target` ('' = no project) does, when
    the chat is now in `here` ('' = none): null for nothing, else the act verb
    and whether it took the chat out of every project. Pure, unit-tested. */
function chatDropPlan(sid, target, here) {
  if (typeof sid !== 'string' || !sid || typeof target !== 'string') return null;
  const now = typeof here === 'string' ? here : '';
  if (target === now) return null;
  return {act: 'fput:' + target + ':' + sid, out: target === ''};
}

/* The project a chat is filed in now, as chat-projects.js projectPickItems reads it. */
function chatDropHere(sid) {
  const f = typeof FOLDERS !== 'undefined' && FOLDERS.state && FOLDERS.state.chats ? FOLDERS.state.chats[sid] : '';
  const p = typeof PROJECTS !== 'undefined' && PROJECTS.state && PROJECTS.state.chats ? PROJECTS.state.chats[sid] : '';
  return f || p || '';
}

/* The drop zone under the pointer: the node that holds the target id
   (data-fdrop) and is lit. A project's header, or the header of the project
   whose chats are under the pointer, or the Chats list's heading. */
function chatDropZone(el) {
  if (!el || typeof el.closest !== 'function') return null;
  const direct = el.closest('#sidebar [data-fdrop]');
  if (direct) return direct;
  const group = el.closest('#sidebar .sb-project');
  if (group) return group.querySelector('[data-fdrop]');
  const list = el.closest('#sidebar [data-list="chats"]');
  return list ? list.querySelector('[data-fdrop]') : null;
}

const CHAT_DRAG = {sid: ''};

if (typeof document !== 'undefined') {
  const dragging = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(FOLDER_DRAG_TYPE));
  const unlight = (keep) => document.querySelectorAll('#sidebar .fdrop-on').forEach((n) => { if (n !== keep) n.classList.remove('fdrop-on'); });
  document.addEventListener('dragstart', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('#sidebar .sesrow[data-ses]') : null;
    if (!row || !e.dataTransfer) return;
    CHAT_DRAG.sid = row.dataset.ses;
    e.dataTransfer.setData(FOLDER_DRAG_TYPE, row.dataset.ses);
    e.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragover', (e) => {
    if (!dragging(e)) return;
    const t = chatDropZone(e.target);
    unlight(t);
    if (!t) return;
    e.preventDefault();
    // The chat's own project is no target: nothing would change.
    const same = CHAT_DRAG.sid && !chatDropPlan(CHAT_DRAG.sid, t.dataset.fdrop || '', chatDropHere(CHAT_DRAG.sid));
    e.dataTransfer.dropEffect = same ? 'none' : 'move';
    if (same) t.classList.remove('fdrop-on'); else t.classList.add('fdrop-on');
  });
  document.addEventListener('dragleave', (e) => {
    if (!dragging(e)) return;
    const sb = document.getElementById('sidebar');
    if (sb && !sb.contains(e.relatedTarget)) unlight(null);
  });
  document.addEventListener('drop', (e) => {
    if (!dragging(e)) return;
    const t = chatDropZone(e.target);
    unlight(null);
    if (!t) return;
    e.preventDefault();
    const sid = e.dataTransfer.getData(FOLDER_DRAG_TYPE) || CHAT_DRAG.sid;
    CHAT_DRAG.sid = '';
    const target = t.dataset.fdrop || '';
    const plan = chatDropPlan(sid, target, chatDropHere(sid));
    if (!plan) return;
    act(plan.act);
    if (chatDropHere(sid) !== target) return;   // refused (projectPutChat): nothing moved
    const p = plan.out ? null : (typeof projectAny === 'function' ? projectAny(target) : null);
    if (typeof toast === 'function') toast(plan.out ? 'Removed from project' : 'Moved to project', plan.out ? 'The chat is under Chats now' : p ? '“' + p.name + '”' : '');
  });
  document.addEventListener('dragend', () => { CHAT_DRAG.sid = ''; unlight(null); });
}

if (typeof module !== 'undefined') module.exports = {chatDropPlan, chatDropZone};
