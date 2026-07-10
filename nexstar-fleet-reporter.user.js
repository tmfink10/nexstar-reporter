// ==UserScript==
// @name         NexStar Fleet Reporter
// @namespace    https://nexusnavigators.us/
// @version      1.9.0
// @description  Reports your Nexus Legacy fleet positions to the NexStar map, and answers the map's fuel-estimate and own-planet logistics requests. Your session token never leaves your browser. SECURITY: hosted from a public branch-protected GitHub repo, no silent auto-update; the map can only run self-owned transfers without an in-game confirm.
// @match        https://s0.nexuslegacy.space/*
// @match        https://nexstar.nexusnavigators.us/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @connect      nexstar.nexusnavigators.us
// @connect      raw.githubusercontent.com
// ==/UserScript==
// SECURITY — DO NOT re-add @updateURL / @downloadURL. This script runs on the
// game origin with the player's live session and can make authenticated game
// calls, so a silent auto-update is a whole-alliance remote-code-execution risk
// (one malicious push → every member compromised). Updates are DELIBERATE:
// the "Check for updates" menu command notifies, and installing is a manual
// step where the diff can be reviewed. Keep it that way.

(function () {
  'use strict';

  // ── GM bridge (script-storage relay) ────────────────────────────────────────
  // The script now runs on BOTH origins. Tampermonkey's value storage is shared
  // across a script's instances regardless of origin, so the VIEWER instance can
  // hand commands to whichever GAME tab exists — no window handles, no
  // window.open, no focus changes. Game tabs elect a leader (heartbeat) so a
  // command runs exactly once even with several game tabs open.
  const IS_GAME = location.origin === 'https://s0.nexuslegacy.space';

  if (!IS_GAME) {
    // Viewer-origin instance: a thin courier between the page and GM storage.
    const announce = () => {
      try { window.postMessage({ source: 'nexstar-relay', via: 'gm', kind: 'bridge-ready' }, location.origin); } catch (e) { /* */ }
    };
    const pending = new Set();
    window.addEventListener('message', (ev) => {
      if (ev.origin !== location.origin) return;
      const d = ev.data;
      if (!d || d.source !== 'nexstar-viewer') return;
      // Handshake: the viewer probes with bridge-hello whenever it wants proof
      // the courier exists (the one-shot announce below can lose the boot race
      // against the viewer's own listener).
      if (d.kind === 'bridge-hello') { announce(); return; }
      if (!d.gmTransport || !d.id || !d.kind) return;
      if (pending.has(d.id)) {              // resend: nudge the request, keep one listener
        GM_setValue('nx_req', { id: d.id, kind: d.kind, body: d.body, ts: Date.now() });
        return;
      }
      pending.add(d.id);
      const key = 'nx_res_' + d.id;
      const deliver = (res) => {
        pending.delete(d.id);
        try { GM_removeValueChangeListener(lid); } catch (e) { /* */ }
        try { GM_deleteValue(key); } catch (e) { /* */ }
        window.postMessage(Object.assign({ source: 'nexstar-relay', via: 'gm' }, res), location.origin);
      };
      const lid = GM_addValueChangeListener(key, (k, o, res) => { if (res) deliver(res); });
      GM_setValue('nx_req', { id: d.id, kind: d.kind, body: d.body, ts: Date.now() });
      const early = GM_getValue(key, null);   // answered before the listener armed
      if (early) deliver(early);
    });
    announce();
    setTimeout(announce, 1500);   // belt-and-braces against slow viewer boots
    return;   // nothing else runs on the viewer origin
  }

  // ── Config ────────────────────────────────────────────────────────────────
  const INGEST_URL = GM_getValue('ingestUrl', 'https://nexstar.nexusnavigators.us/api/ingest');
  const INTERVAL_SEC = GM_getValue('intervalSec', 30);  // re-report every N seconds while open
  const API_DELAY_MS = 1100;                            // polite gap between game API calls

  // ── Menu: set / change the personal key ─────────────────────────────────────
  GM_registerMenuCommand('Set NexStar key', () => {
    const cur = GM_getValue('apiKey', '');
    const k = prompt('Paste your NexStar ingest key (from the Discord /userscript command):', cur);
    if (k !== null) { GM_setValue('apiKey', k.trim()); alert('NexStar key saved. Reporting will begin shortly.'); kick(); }
  });
  GM_registerMenuCommand('Report fleet now', () => kick(true));
  GM_registerMenuCommand('Set update interval (seconds)', () => {
    const v = prompt('How often to report your fleet, in seconds (min 10):', GM_getValue('intervalSec', 30));
    if (v !== null) {
      const n = Math.max(10, parseInt(v, 10) || 30);
      GM_setValue('intervalSec', n);
      alert('Update interval set to ' + n + 's. Reload the game page to apply.');
    }
  });
  GM_registerMenuCommand('Set ingest URL (advanced)', () => {
    const k = prompt('Ingest endpoint URL:', INGEST_URL);
    if (k !== null) GM_setValue('ingestUrl', k.trim());
  });

  // ── Self-update ─────────────────────────────────────────────────────────────
  // The CANONICAL published copy lives in a public, branch-protected GitHub repo
  // — NOT on the map's VPS. Hosting it there means a VPS compromise can't alter
  // what members install or see as "latest": every version is a reviewed git
  // commit on GitHub's infrastructure. Opening this URL shows the script
  // manager's install/update screen. (Keep this a GitHub raw URL.)
  const SCRIPT_URL = 'https://raw.githubusercontent.com/tmfink10/nexstar-reporter/main/nexstar-fleet-reporter.user.js';
  const CUR_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0';

  function verLt(a, b) {   // is version a strictly older than version b?
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y;
    }
    return false;
  }

  // Fetch the published @version. Returns the version string, or null on failure.
  function fetchLatestVersion() {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET', url: SCRIPT_URL + '?_=' + Date.now(), timeout: 15000,
        onload: (res) => {
          const m = res.responseText && res.responseText.match(/@version\s+([\d.]+)/);
          resolve(m ? m[1] : null);
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  async function checkForUpdate(manual) {
    const latest = await fetchLatestVersion();
    if (!latest) { if (manual) alert('NexStar: could not check for updates right now.'); return; }
    if (verLt(CUR_VERSION, latest)) {
      if (confirm(`NexStar Reporter update available:\n\n   v${CUR_VERSION}  →  v${latest}\n\nOpen the update screen now?`)) {
        window.open(SCRIPT_URL, '_blank');
      }
    } else if (manual) {
      alert(`NexStar Reporter is up to date (v${CUR_VERSION}).`);
    }
  }

  GM_registerMenuCommand('Check for updates', () => checkForUpdate(true));

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Every game API call gets a hard timeout: without one, a single fetch that
  // never settles (network blip, tab back-grounded mid-request) leaves the
  // report loop's `running` flag stuck forever and reporting silently dies.
  const GGET_TIMEOUT_MS = 20000;
  async function gget(path) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), GGET_TIMEOUT_MS);
    try {
      const r = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' }, signal: ctl.signal });
      if (!r.ok) throw new Error('GET ' + path + ' -> HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  function ownedPlanets(me) {
    for (const k of ['planets', 'colonies', 'ownedPlanets']) {
      if (Array.isArray(me && me[k])) return me[k];
    }
    if (me && me.user) return ownedPlanets(me.user);
    return [];
  }

  // Owned-planet ids, kept fresh from each report — the security gate below uses
  // it to distinguish a safe self-logistics move from a dangerous one.
  let _ownedPlanetIds = new Set();
  function _rememberOwned(me) {
    try { _ownedPlanetIds = new Set(ownedPlanets(me).map(p => p && p.id).filter(x => x != null)); } catch (e) { /* */ }
  }
  async function ownedPlanetIds() {
    if (_ownedPlanetIds.size) return _ownedPlanetIds;
    try { _rememberOwned(await gget('/api/auth/me')); } catch (e) { /* */ }
    return _ownedPlanetIds;
  }

  function post(payload, key) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: INGEST_URL,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        data: JSON.stringify(payload),
        timeout: 20000,
        onload: (res) => resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, body: res.responseText }),
        onerror: () => resolve({ ok: false, status: 0, body: 'network error' }),
        ontimeout: () => resolve({ ok: false, status: 0, body: 'timeout' }),
      });
    });
  }

  // Planet detail (building levels) refreshes every 5 minutes, not every
  // 30-second cycle — buildings change slowly and this halves the extra load.
  // Trimmed client-side so the ingest payload stays small: only built slots
  // (level > 0) or slots mid-upgrade, key/name/level(+upgrading/damage) each.
  const PLANET_INFO_TTL_MS = 5 * 60 * 1000;
  // Building DEFINITIONS (descriptions, base costs, production fields) are
  // static game data — sent as a catalog at most once per 24h (GM-persisted
  // across tabs); the server merges them into building_catalog.json. The
  // frequent planetInfos carry a deny-listed copy instead: every dynamic
  // field survives, only the definition bloat is slimmed to {key, name}.
  const BUILDING_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
  let _planetInfoCache = { at: 0, data: {} };
  function slimPlanetInfo(d) {
    const buildings = ((d && d.buildings) || [])
      .filter(b => b && ((b.level || 0) > 0 || b.isUpgrading))
      .map(b => Object.assign({}, b, {
        definition: { key: (b.definition || {}).key, name: (b.definition || {}).name },
      }));
    return { planet: (d && d.planet) || null, buildings };
  }
  async function planetInfos(planets) {
    const catalogDue = Date.now() - +(GM_getValue('nx_bcat_at', 0)) > BUILDING_CATALOG_TTL_MS;
    if (!catalogDue && Date.now() - _planetInfoCache.at < PLANET_INFO_TTL_MS) {
      return { infos: _planetInfoCache.data, catalog: null };
    }
    const out = {};
    const defs = {};   // building key -> full raw definition (newest wins)
    for (const p of planets) {
      if (p == null || p.id == null) continue;
      await sleep(API_DELAY_MS);
      try {
        const d = await gget('/api/planets/' + p.id);
        out[p.id] = slimPlanetInfo(d);
        if (catalogDue) {
          ((d && d.buildings) || []).forEach(b => {
            const def = b && b.definition;
            if (def && def.key) defs[def.key] = def;
          });
        }
      }
      catch (e) { /* skip a planet we can't read */ }
    }
    _planetInfoCache = { at: Date.now(), data: out };
    const catalog = Object.values(defs);
    if (catalog.length) GM_setValue('nx_bcat_at', Date.now());
    return { infos: out, catalog: catalog.length ? catalog : null };
  }

  // Own mining outposts (/api/outposts): level, module levels, stored
  // resources + rates, and the asteroid field being worked. Slimmed
  // client-side (data minimization, same policy as `me`): only the fields the
  // map's Empire Console shows — construction job ids, relocation state,
  // rename cooldowns etc. never leave the browser.
  const OUTPOST_RES_KEYS = ['ore', 'silicates', 'hydrogen', 'alloys', 'cryoIce',
                            'quantumDust', 'plasmaCore', 'bioExtract', 'darkMatter'];
  function slimOutpost(o) {
    if (!o || o.id == null) return null;
    const f = o.asteroidField || {};
    const resources = {}, rates = {};
    OUTPOST_RES_KEYS.forEach(k => {
      if (+o[k] > 0) resources[k] = +o[k];
      if (+o[k + 'Rate'] > 0) rates[k] = +o[k + 'Rate'];
    });
    return {
      id: o.id, name: o.name, level: o.level, systemId: o.systemId,
      resources, rates,
      basicStorage: o.basicStorage, rareStorage: o.rareStorage,
      hp: o.hp, maxHp: o.maxHp, shieldHp: o.shieldHp, shieldMaxHp: o.shieldMaxHp,
      deployedShipCount: o.deployedShipCount,
      isConstructing: !!o.isConstructing,
      constructionEndsAt: o.constructionEndsAt || null,
      pendingBuildingKey: o.pendingBuildingKey || null,
      buildings: (o.buildings || []).map(b => ({ key: b && (b.buildingKey || b.key), level: (b && b.level) || 0 })),
      field: { id: f.id, name: f.name, fieldType: f.fieldType, richness: f.richness,
               totalResources: f.totalResources, remainingResources: f.remainingResources },
    };
  }

  let running = false;
  let runStartedAt = 0;
  async function report(manual) {
    const key = (GM_getValue('apiKey', '') || '').trim();
    if (!key) { if (manual) alert('No NexStar key set. Use the Tampermonkey menu → "Set NexStar key".'); return; }
    // Watchdog: a report cycle should finish in well under 5 minutes even on a
    // big empire. If `running` has been held longer, the previous cycle died
    // without cleanup — reclaim the flag instead of staying wedged forever.
    if (running && Date.now() - runStartedAt > 5 * 60 * 1000) {
      console.warn('[NexStar] previous report cycle wedged — resetting.');
      running = false;
    }
    if (running) return;
    running = true;
    runStartedAt = Date.now();
    try {
      const me = await gget('/api/auth/me');
      const planets = ownedPlanets(me);
      _rememberOwned(me);   // keep the security gate's owned-planet set current
      const planetFleets = {};
      for (const p of planets) {
        if (p == null || p.id == null) continue;
        await sleep(API_DELAY_MS);
        try { planetFleets[p.id] = await gget('/api/planets/' + p.id + '/fleet'); }
        catch (e) { /* skip a planet we can't read */ }
      }
      await sleep(API_DELAY_MS);
      let missions = [];
      let maxFleetSlots = null;   // fleet-slot cap rides the missions payload
      try {
        const m = await gget('/api/fleet/missions');
        missions = (m && m.missions) || [];
        if (m && m.maxFleetSlots > 0) maxFleetSlots = m.maxFleetSlots;
      }
      catch (e) { /* missions optional */ }

      await sleep(API_DELAY_MS);
      let spyReports = [];
      try { const sr = await gget('/api/fleet/spy-reports'); spyReports = (sr && sr.reports) || []; }
      catch (e) { /* spy reports optional */ }

      // Research is account-wide; any owned planet id works as the lab context.
      await sleep(API_DELAY_MS);
      let research = [];
      const firstPlanet = planets.find(p => p && p.id != null);
      if (firstPlanet) {
        try { const rs = await gget('/api/research?planetId=' + firstPlanet.id); research = (rs && rs.research) || []; }
        catch (e) { /* research optional — strength falls back to base attack */ }
      }

      // Battle reports: fetch the summary list, keep only real targets (enemy
      // planet/station — has planetId or defenderId), and pull detail for those.
      // PvE/pirate fights (no planetId/defenderId) are skipped.
      await sleep(API_DELAY_MS);
      let battleReports = [];
      try {
        const br = await gget('/api/fleet/reports');
        const list = (br && br.reports) || [];
        for (const s of list) {
          if (!s || !(s.planetId || s.defenderId) || s.id == null) continue;
          await sleep(API_DELAY_MS);
          try { const d = await gget('/api/fleet/reports/' + s.id); if (d) battleReports.push(d.report || d); }
          catch (e) { /* skip a report we can't read */ }
        }
      } catch (e) { /* battle reports optional */ }

      // Own mining outposts — optional (older servers / none built yet).
      await sleep(API_DELAY_MS);
      let outposts = [];
      try {
        const op = await gget('/api/outposts');
        outposts = ((op && op.outposts) || []).map(slimOutpost).filter(Boolean);
      } catch (e) { /* outposts optional */ }

      // Building levels per colony (cached 5 min) + the static-definitions
      // catalog at most once per 24h — see planetInfos.
      const pi = await planetInfos(planets);

      // Data minimization: the report only needs WHO you are and WHERE your
      // planets are. Never forward account details (email, Steam id, vacation
      // and billing state, …) to the map server.
      const meSlim = {
        user: { id: ((me && me.user) || {}).id, username: ((me && me.user) || {}).username },
        planets: (me && me.planets) || [],
      };

      const scriptVersion = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || null;
      const payload = { me: meSlim, planetFleets, planetInfos: pi.infos, missions, maxFleetSlots,
                        spyReports, research, battleReports, outposts, scriptVersion };
      if (pi.catalog) payload.buildingCatalog = pi.catalog;
      const res = await post(payload, key);
      if (res.ok) {
        console.log('[NexStar] reported fleet OK:', res.body);
      } else if (res.status === 401) {
        console.warn('[NexStar] key rejected (401). Re-set it via the Tampermonkey menu.');
        if (manual) alert('NexStar rejected your key. Run /userscript in Discord again and re-paste it.');
      } else if (res.status === 429) {
        console.log('[NexStar] throttled (429) — will retry next cycle.');
      } else {
        console.warn('[NexStar] report failed:', res.status, res.body);
      }
    } catch (e) {
      console.warn('[NexStar] reporting error:', e.message);
    } finally {
      running = false;
    }
  }

  let kickTimer = null;
  function kick(manual) {
    clearTimeout(kickTimer);
    kickTimer = setTimeout(() => report(manual), manual ? 0 : 4000);
  }

  // Initial report shortly after load, then on the interval.
  kick(false);
  setInterval(() => report(false), Math.max(10, INTERVAL_SEC) * 1000);
  console.log('[NexStar] Fleet Reporter active (every ' + Math.max(10, INTERVAL_SEC) + 's). '
            + 'Set your key via the Tampermonkey menu if you haven\'t.');

  // Proactively check once on load; if a newer version is published, surface a
  // prominent one-click "update" command in the script-manager menu.
  fetchLatestVersion().then((latest) => {
    if (latest && verLt(CUR_VERSION, latest)) {
      GM_registerMenuCommand('⬆ Update NexStar Reporter → v' + latest, () => window.open(SCRIPT_URL, '_blank'));
      console.log('[NexStar] update available: v' + CUR_VERSION + ' → v' + latest);
    }
  });

  // ── Map-viewer bridge: same-origin fuel/travel estimate relay ───────────────
  // The NexStar map runs on a different origin, so it can't call the game API
  // directly (CORS + cookie). THIS tab can — it shares the game session. We answer
  // the viewer's postMessage requests by calling /api/fleet/fuel-estimate with the
  // live cookie and posting the exact result back. No token leaves the browser;
  // the call is the same same-origin, credentials:'include' fetch we already use.
  const VIEWER_ORIGINS = (() => {
    const out = ['https://nexstar.nexusnavigators.us'];
    // Allow an override (advanced/self-hosters) without touching code.
    try { const extra = (GM_getValue('viewerOrigin', '') || '').trim(); if (extra) out.push(extra); } catch (e) { /* */ }
    return out;
  })();
  const okOrigin = (o) => VIEWER_ORIGINS.indexOf(o) !== -1;

  async function gamePost(path, body) {
    const r = await fetch(path, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = JSON.parse(await r.text()); } catch (e) { /* tolerate non-JSON error bodies */ }
    if (!r.ok) {
      const msg = (data && (data.error || data.message)) || ('HTTP ' + r.status);
      throw new Error(msg);
    }
    return data;
  }

  const fuelEstimate = (body) => gamePost('/api/fleet/fuel-estimate', body);

  // ── Mission launch (viewer estimator "execute the move") ───────────────────
  // The dispatch API routes by mission type: most types go through /fleet/dispatch;
  // espionage variants have dedicated endpoints. Only the types below may be
  // launched through the relay — anything else is refused here, regardless of
  // what the (trusted-origin) viewer asked for.
  const DISPATCH_TYPES = ['transfer', 'deliver', 'attack', 'raid', 'gift', 'garrison'];
  const DEDICATED_ROUTES = { spy: '/api/fleet/spy', stealth_deploy: '/api/fleet/stealth-deploy' };

  // SECURITY GATE. A move is "safe" only when it's a transfer/deliver to one of
  // the player's OWN planets — shuffling your own ships/goods among your own
  // bases cannot be used to rob you or attack anyone. EVERYTHING ELSE (hostile
  // attack/raid, gift or garrison to another player, spy/stealth, or any move
  // aimed off your own planets — including a moon, whose ownership we can't
  // cheaply confirm) demands an explicit in-game confirmation. This is the wall
  // that stops a compromised map from silently emptying your account: it can
  // REQUEST a dangerous action, but only a human clicking OK in the game tab can
  // run it. The confirm fails CLOSED — if a background tab suppresses the dialog
  // it returns false and the action is refused.
  const SAFE_TYPES = ['transfer', 'deliver'];
  async function launchGateOk(type, tgt, moon, ships) {
    const owned = await ownedPlanetIds();
    if (SAFE_TYPES.indexOf(type) !== -1 && tgt && !moon && owned.has(tgt)) return true;
    const n = ships.reduce((a, s) => a + (s.quantity || 0), 0);
    const where = moon ? ('moon #' + moon) : ('planet #' + tgt);
    try { window.focus(); } catch (e) { /* */ }
    return window.confirm(
      'NexStar Reporter — the map is asking to run a ' + String(type || '?').toUpperCase() +
      ' mission (' + n + ' ship' + (n === 1 ? '' : 's') + ') to ' + where + '.\n\n' +
      'This can send your fleet away or hand over resources. Click OK ONLY if you just started ' +
      'this yourself from the map. If this appeared on its own, click Cancel.\n\nAllow it?');
  }

  async function launchMission(req) {
    const b = req || {};
    const src = +b.sourcePlanetId, tgt = +b.targetPlanetId, moon = +b.targetMoonId;
    const ships = Array.isArray(b.ships)
      ? b.ships.map(s => ({ shipDefId: +s.shipDefId, quantity: +s.quantity }))
                .filter(s => s.shipDefId > 0 && s.quantity > 0)
      : [];
    // exactly one destination: a planet OR a moon (dispatch addresses them via
    // separate fields)
    if (!src || !ships.length || (!tgt && !moon) || (tgt && moon)) return Promise.reject(new Error('bad launch request'));
    if (!(await launchGateOk(b.missionType, tgt, moon, ships))) return Promise.reject(new Error('launch not confirmed'));
    const target = tgt ? { targetPlanetId: tgt } : { targetMoonId: moon };
    if (DEDICATED_ROUTES[b.missionType]) {
      return gamePost(DEDICATED_ROUTES[b.missionType], Object.assign({ sourcePlanetId: src, ships }, target));
    }
    if (DISPATCH_TYPES.indexOf(b.missionType) !== -1) {
      const payload = Object.assign({ sourcePlanetId: src, missionType: b.missionType, ships, cargo: b.cargo || {} }, target);
      if (b.speedFactor && b.speedFactor < 1) payload.speedFactor = +b.speedFactor;
      return gamePost('/api/fleet/dispatch', payload);
    }
    return Promise.reject(new Error('unsupported mission type: ' + b.missionType));
  }

  function recallMission(req) {
    const id = +((req || {}).missionId);
    if (!id) return Promise.reject(new Error('bad recall request'));
    return gamePost('/api/fleet/missions/' + id + '/recall', {});
  }

  // Planet snapshot for the viewer's cargo picker: current resources on the
  // source planet + free storage on the destination. Only the numeric-id
  // planets route (a read the player can already see in-game).
  function planetInfo(req) {
    const id = +((req || {}).planetId);
    if (!id) return Promise.reject(new Error('bad planet-info request'));
    return gget('/api/planets/' + id);
  }

  // Tell the opener (the viewer that spawned this tab) the relay is live. opener is
  // cross-origin, so we post to each trusted viewer origin explicitly.
  function announceReady() {
    if (!window.opener) return;
    for (const o of VIEWER_ORIGINS) {
      try { window.opener.postMessage({ source: 'nexstar-relay', kind: 'ready' }, o); } catch (e) { /* */ }
    }
  }

  // The viewer opens this tab with #nexstar-return when it only needs the relay
  // (launch/cargo commands) — the user shouldn't land here. Hand focus straight
  // back to the viewer (focus/blur are allowed on the cross-origin opener) and
  // strip the marker so a manual reload behaves normally.
  function returnFocusIfCommandOpen() {
    if (location.hash !== '#nexstar-return') return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* */ }
    try { window.blur(); } catch (e) { /* */ }
    try { if (window.opener) window.opener.focus(); } catch (e) { /* */ }
  }
  returnFocusIfCommandOpen();

  // ── Explore/Ops helper (v1.7) ──────────────────────────────────────────────
  // The viewer owns the ranking + config; this side does the two things only the
  // game tab can: SCAN the per-job endpoints (all reads) and DISPATCH the chosen
  // job. Every list below was confirmed live against the game (see the map's
  // docs/NEXUS_PLATFORM_GUIDE.md). Scan returns raw-ish lists the viewer's
  // exploreCandidates() normalizes; dispatch builds the exact per-endpoint body.
  const EXPLORE_META = ['id','systemId','systemName','systemX','systemY','expiresAt',
    'guardedByPirates','remainingPirates','name','createdAt','discoveredByUserId',
    'exclusiveUntil','massUsed'];
  async function exploreScan(req) {
    const en = (req && req.enabled) || {};
    const want = t => en[t] !== false;                 // default on unless explicitly disabled
    const listOf = async (path, key) => { try { const d = await gget(path); return (d && d[key]) || []; } catch (e) { return []; } };

    const me = await gget('/api/auth/me').catch(() => null);
    const planets = (me && me.planets) || [];

    // Planet fleets power both salvage hauling (available cargo ships) and repair
    // (damaged ships), so fetch each once when either job needs it.
    const fleetByPlanet = {};
    if (want('salvage') || want('repair')) {
      for (const p of planets) {
        try { fleetByPlanet[p.id] = await gget('/api/planets/' + p.id + '/fleet'); } catch (e) { /* skip */ }
      }
    }
    // Utility cargo ships on hand, with EFFECTIVE hold size (base × research cargo
    // bonus; shuttles use the shuttle bonus). The viewer sizes a salvage pickup
    // from these, biggest holds first.
    const haulersFor = (fd) => {
      const cb = +((fd && fd.cargoBonus)) || 0, scb = +((fd && fd.shuttleCargoBonus)) || 0;
      return ((fd && fd.fleet) || [])
        .filter(s => s.definition && s.definition.shipClass === 'utility' && (s.definition.cargoCapacity || 0) > 0)
        .map(s => ({ shipType: s.definition.key, shipDefId: s.shipDefId, available: s.quantity,
          cargo: Math.round(s.definition.cargoCapacity * (1 + (/shuttle/.test(s.definition.key || '') ? scb : cb))) }));
    };
    const result = { planets: planets.map(p => {
      const base = { id: p.id, name: p.name, systemId: p.systemId, systemName: p.systemName,
                     systemX: p.systemX, systemY: p.systemY, isHomeworld: !!p.isHomeworld };
      if (want('salvage')) base.haulers = haulersFor(fleetByPlanet[p.id]);
      return base;
    }) };

    if (want('salvage')) {
      result.debris = (await listOf('/api/fleet/system-debris', 'debris')).map(d => {
        const resources = {};
        for (const k in d) if (EXPLORE_META.indexOf(k) === -1 && typeof d[k] === 'number') resources[k] = d[k];
        return { id: d.id, systemId: d.systemId, systemName: d.systemName, systemX: d.systemX,
                 systemY: d.systemY, resources, guardedByPirates: !!d.guardedByPirates, expiresAt: d.expiresAt };
      });
    }
    if (want('pirates')) {
      result.pirates = (await listOf('/api/fleet/pirate-camps', 'camps')).map(c => ({
        id: c.id, systemId: c.systemId, systemName: c.systemName, systemX: c.systemX, systemY: c.systemY,
        tier: c.tier, lootTier: c.lootTier, currentHpPercent: c.currentHpPercent, hasFleetIntel: !!c.hasFleetIntel }));
    }
    if (want('wormhole')) {
      result.wormholes = (await listOf('/api/fleet/wormholes', 'wormholes')).map(w => ({
        id: w.id, systemId: w.systemId, systemName: w.systemName, systemX: w.systemX, systemY: w.systemY,
        wormholeClass: w.wormholeClass, massLimit: w.massLimit, expiresAt: w.expiresAt }));
    }
    if (want('investigate')) {
      // A survey can turn up an anomaly to investigate. Candidates = survey
      // reports not yet investigated whose anomaly hasn't expired.
      const now = Date.now();
      result.anomalies = (await listOf('/api/fleet/survey-reports', 'reports'))
        .filter(r => !r.investigated && r.anomalyExpiresAt && new Date(r.anomalyExpiresAt).getTime() > now)
        .map(r => ({ id: r.id, systemId: r.systemId, systemName: r.systemName, systemX: r.systemX,
          systemY: r.systemY, eventTitle: r.eventTitle, expiresAt: r.anomalyExpiresAt }));
    }
    if (want('survey')) {
      const [gm, cd] = await Promise.all([ gget('/api/galaxy/map').catch(() => null),
                                           gget('/api/fleet/survey-cooldowns').catch(() => null) ]);
      const now = Date.now();
      const onCd = new Set(((cd && cd.cooldowns) || [])
        .filter(c => new Date(c.cooldownEndsAt).getTime() > now).map(c => c.systemId));
      // EVERY system is surveyable once its per-system cooldown expires — survey is
      // re-run for fresh intel, not just first exploration — so the pool is all
      // systems minus those cooling down (NOT a visibility filter). A survey
      // launches from a planet, so keep the ones nearest each of the player's
      // planets, capped to keep the bridge payload small.
      const systems = ((gm && gm.systems) || []).filter(s => !onCd.has(s.id));
      const PER_PLANET = 150;
      const picked = new Map();
      for (const p of planets) {
        systems
          .map(s => ({ s, d: Math.hypot((p.systemX || 0) - s.x, (p.systemY || 0) - s.y) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, PER_PLANET)
          .forEach(e => picked.set(e.s.id, e.s));
      }
      result.surveyable = [...picked.values()]
        .map(s => ({ systemId: s.id, name: s.name, x: s.x, y: s.y, visibility: s.visibility }));
    }
    if (want('mine')) {   // heavy (~7k) — only when the user turns mining on
      result.fields = (await listOf('/api/galaxy/field-index', 'systems'))
        .filter(f => f.totalRemaining > 0 && !f.allianceLocked)
        .map(f => ({ systemId: f.systemId, systemName: f.systemName, x: f.systemX, y: f.systemY,
          fieldType: f.fieldType, totalRemaining: f.totalRemaining, richness: f.maxRichness, fieldId: f.richestFieldId }));
    }
    if (want('repair')) {
      result.repairs = [];
      for (const p of planets) {
        const fd = fleetByPlanet[p.id];
        const ships = ((fd && fd.fleet) || []).filter(s => (+s.damagedQuantity || 0) > 0).map(s => ({
          shipType: (s.definition && s.definition.key) || ('def' + s.shipDefId), shipDefId: s.shipDefId,
          damaged: s.damagedQuantity, shipClass: s.definition && s.definition.shipClass }));
        if (ships.length) result.repairs.push({ planetId: p.id, planetName: p.name, systemId: p.systemId,
          systemName: p.systemName, x: p.systemX, y: p.systemY, ships });
      }
    }
    return result;
  }

  // Dispatch the chosen Ops job. The viewer passes the exact call(s) to make:
  // { calls: [{ endpoint, body }, ...] } (repair sends several).
  // SECURITY: the allowlist is the EXACT set of Ops endpoints, NOT a broad
  // /api/fleet/* pattern. The old wildcard let a compromised map reach
  // /api/fleet/dispatch (i.e. attack another player or gift your resources away)
  // through this channel; these regexes deny that. Adding a genuinely new Ops
  // job type is the one thing that now needs a userscript bump — a deliberate,
  // reviewable trade for closing the backdoor.
  const EXPLORE_DISPATCH_OK = [
    /^\/api\/fleet\/survey$/, /^\/api\/fleet\/collect-debris$/, /^\/api\/fleet\/attack-pirates$/,
    /^\/api\/fleet\/wormhole-run$/, /^\/api\/fleet\/investigate$/, /^\/api\/fleet\/mine$/,
    /^\/api\/planets\/\d+\/shipyard\/repair$/,
  ];
  function exploreDispatch(req) {
    const b = req || {};
    const calls = Array.isArray(b.calls) ? b.calls
      : (b.endpoint ? [{ endpoint: b.endpoint, body: b.body }] : []);
    if (!calls.length) return Promise.reject(new Error('no dispatch calls'));
    for (const c of calls) {
      if (!c || typeof c.endpoint !== 'string' || !EXPLORE_DISPATCH_OK.some(re => re.test(c.endpoint)))
        return Promise.reject(new Error('endpoint not allowed: ' + (c && c.endpoint)));
    }
    return Promise.all(calls.map(c => gamePost(c.endpoint, c.body || {})))
      .then(results => (results.length === 1 ? results[0] : { results }));
  }

  const RPC = { 'fuel-estimate': fuelEstimate, 'launch-mission': launchMission, 'recall-mission': recallMission,
                'planet-info': planetInfo, 'explore-scan': exploreScan, 'explore-dispatch': exploreDispatch };

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d.source !== 'nexstar-viewer' || !okOrigin(ev.origin)) return;   // only our viewer, only trusted origins
    const reply = (msg) => {
      try { ev.source.postMessage(Object.assign({ source: 'nexstar-relay', id: d.id }, msg), ev.origin); }
      catch (e) { /* source/window gone */ }
    };
    if (d.kind === 'ping') { reply({ kind: 'pong' }); return; }   // readiness probe (covers a missed 'ready')
    if (RPC[d.kind]) {
      try { reply({ kind: d.kind + '-result', ok: true, data: await RPC[d.kind](d.body) }); }
      catch (e) { reply({ kind: d.kind + '-result', ok: false, error: String((e && e.message) || e) }); }
    }
  });

  // ── GM-bridge server (game side) ────────────────────────────────────────────
  // Answers commands the viewer instance drops into script storage. Game tabs
  // elect a leader via a heartbeat so each command runs EXACTLY once no matter
  // how many game tabs are open; a dead leader is replaced within ~15s.
  const TAB_ID = 't' + Math.random().toString(36).slice(2);
  const LEADER_TTL = 15000;
  function claimLeader() {
    try {
      const l = GM_getValue('nx_leader', null);
      if (!l || l.id === TAB_ID || Date.now() - l.ts > LEADER_TTL) GM_setValue('nx_leader', { id: TAB_ID, ts: Date.now() });
    } catch (e) { /* */ }
  }
  claimLeader();
  setInterval(claimLeader, 5000);
  const amLeader = () => { const l = GM_getValue('nx_leader', null); return !!l && l.id === TAB_ID; };
  const _gmHandled = new Set();   // request ids this tab already ran (resend nudges)
  GM_addValueChangeListener('nx_req', async (k, o, req) => {
    if (!req || !req.id || !req.kind || !amLeader()) return;
    const respond = (msg) => {
      GM_setValue('nx_res_' + req.id, Object.assign({ id: req.id }, msg));
      setTimeout(() => { try { GM_deleteValue('nx_res_' + req.id); } catch (e) { /* */ } }, 30000);
    };
    if (req.kind === 'ping') { respond({ kind: 'pong', ok: true }); return; }
    if (!RPC[req.kind] || _gmHandled.has(req.id)) return;
    _gmHandled.add(req.id);
    setTimeout(() => _gmHandled.delete(req.id), 60000);
    try { respond({ kind: req.kind + '-result', ok: true, data: await RPC[req.kind](req.body) }); }
    catch (e) { respond({ kind: req.kind + '-result', ok: false, error: String((e && e.message) || e) }); }
  });

  announceReady();
})();
