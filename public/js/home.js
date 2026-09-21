/* Landing page: list live / waiting / past streams, auto-refreshing. */
'use strict';

(() => {
  const ui = {
    liveNow: $('#liveNow'), liveList: $('#liveList'),
    upcoming: $('#upcoming'), upcomingList: $('#upcomingList'),
    past: $('#past'), pastList: $('#pastList'),
    empty: $('#empty'), offlineNote: $('#offlineNote'),
  };
  const show = (el, on = true) => { el.hidden = !on; };

  function card(s) {
    const a = document.createElement('a');
    a.className = 'session-card';
    a.href = `/watch/${encodeURIComponent(s.id)}`;
    const status = s.live
      ? '<span class="chip chip-live">● LIVE</span>'
      : s.endedAt
        ? '<span class="chip chip-idle">Recording</span>'
        : '<span class="chip chip-warn">Interrupted</span>';
    a.innerHTML = `
      <div class="session-card-top">${status}<span class="tag res-tag" hidden></span></div>
      <h3 class="session-card-title"></h3>
      <p class="muted session-card-sub"></p>`;
    a.querySelector('.session-card-title').textContent = s.title;
    const res = fmt.res(s.width, s.height);
    if (res) {
      const tag = a.querySelector('.res-tag');
      tag.textContent = res;
      tag.hidden = false;
    }
    a.querySelector('.session-card-sub').textContent = s.live
      ? `${s.viewers} watching · started ${fmt.clock(s.createdAt)}`
      : `${fmt.clock(s.createdAt)}${s.totalMs ? ` · ${fmt.dur(s.totalMs)}` : ''}`;
    return a;
  }

  async function refresh() {
    let data;
    try {
      data = await api('/api/sessions', { timeoutMs: 8000 });
      show(ui.offlineNote, false);
    } catch (e) {
      if (e.status === 401) {
        const site = await api('/api/site').catch(() => null);
        if (site?.viewerKeyRequired) {
          const k = prompt('This site is private. Enter the viewing code from your invitation:');
          if (k !== null) { store.set('viewerKey', k.trim()); refresh(); }
        }
        return;
      }
      show(ui.offlineNote, true);
      return;
    }
    $('#siteTitle').textContent = data.siteTitle;
    $('#heroTitle').textContent = data.siteTitle;
    document.title = data.siteTitle;

    const live = data.sessions.filter((s) => s.live);
    const waiting = data.sessions.filter((s) => !s.live && !s.endedAt && s.segmentCount === 0);
    const past = data.sessions.filter((s) => !s.live && (s.endedAt || s.segmentCount > 0));

    const fill = (wrapEl, listEl, items) => {
      show(wrapEl, items.length > 0);
      listEl.innerHTML = '';
      for (const s of items) listEl.appendChild(card(s));
    };
    fill(ui.liveNow, ui.liveList, live);
    fill(ui.upcoming, ui.upcomingList, waiting);
    fill(ui.past, ui.pastList, past);
    show(ui.empty, data.sessions.length === 0);

    // A single live stream is what guests came for: jump straight in.
    if (live.length === 1 && new URLSearchParams(location.search).has('auto')) {
      location.href = `/watch/${encodeURIComponent(live[0].id)}`;
    }
  }

  refresh();
  setInterval(refresh, 5000);
})();
