/* One operation touches the agent at a time. A newer choice replaces only
 * its own lane: choosing a model must not discard a chosen coding mode. */
function createSwitchQueue(changed) {
  let active = null;
  const waiting = new Map();
  let serial = 0;
  let routeBarrier = false;
  const latest = new Map();
  const superseded = () => ({ok:false, superseded:true, cancelled:true});
  function snapshot() {
    const entries = [...(active ? [active] : []), ...waiting.values()];
    let want = null;
    for (const entry of entries) {
      if (entry.lane === 'route') {
        const mode = want && want.mode;
        want = Object.assign({}, entry.want);
        if (mode) want.mode = mode;
      } else want = Object.assign({}, want, entry.want);
    }
    // A coding-mode choice queued behind a route still holds Send until
    // both have landed, even though a standalone mode change is immediate.
    if (routeBarrier && want) delete want.route;
    return {pending: entries.length ? 1 : 0, want, label: entries.length ? entries[entries.length - 1].label : ''};
  }
  function publish() { changed(snapshot()); }
  async function drain() {
    if (active) return;
    while (waiting.size) {
      const [lane, entry] = waiting.entries().next().value;
      waiting.delete(lane);
      active = entry;
      publish();
      const current = () => latest.get(lane) === entry.serial;
      try {
        const result = await entry.run(current);
        entry.resolve(current() ? result : superseded());
      } catch (error) {
        if (current()) entry.reject(error); else entry.resolve(superseded());
      } finally {
        active = null;
        if (!waiting.size) routeBarrier = false;
        publish();
      }
    }
  }
  return {
    submit(lane, label, want, run) {
      if (lane === 'route') routeBarrier = true;
      const previous = waiting.get(lane);
      if (previous) previous.resolve(superseded());
      return new Promise((resolve, reject) => {
        const entry = {lane, label, want, run, resolve, reject, serial: ++serial};
        latest.set(lane, entry.serial);
        waiting.set(lane, entry);
        publish();
        void drain();
      });
    },
    snapshot,
  };
}
if (typeof module !== 'undefined') module.exports = {createSwitchQueue};
