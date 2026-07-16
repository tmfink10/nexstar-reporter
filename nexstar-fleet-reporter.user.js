// ==UserScript==
// @name         NexStar Fleet Reporter
// @namespace    https://nexusnavigators.us/
// @version      1.21.0
// @description  Reports your Nexus Legacy fleet positions to the NexStar map, and answers the map's fuel-estimate and own-planet logistics requests. Your session token never leaves your browser. SECURITY: hosted from a public branch-protected GitHub repo, no silent auto-update; the map can only run self-owned actions (transfers, colony builds) without an in-game confirm.
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

  // ==US-ENGINE-START== pure decision logic — no GM_*, no fetch, no closures.
  // Extracted verbatim by tests/userscript_engine.mjs and EXECUTED, so the
  // security allowlist and the slimmers are behavior-tested, not just
  // regex-pinned (review finding F22).

  // Data minimization: the report only needs WHO you are and WHERE your
  // planets are. Never forward account details (email, Steam id, vacation
  // and billing state, …) to the map server.
  function slimMe(me) {
    return {
      user: { id: ((me && me.user) || {}).id, username: ((me && me.user) || {}).username },
      planets: (me && me.planets) || [],
    };
  }

  // Building DEFINITIONS are static game data — the frequent planetInfos carry
  // a deny-listed copy: every dynamic field survives, only the definition
  // bloat is slimmed to {key, name}.
  function slimPlanetInfo(d) {
    const buildings = ((d && d.buildings) || [])
      .filter(b => b && ((b.level || 0) > 0 || b.isUpgrading))
      .map(b => Object.assign({}, b, {
        definition: { key: (b.definition || {}).key, name: (b.definition || {}).name },
      }));
    return { planet: (d && d.planet) || null, buildings };
  }

  // /api/planets/{id}/shipyard: planetaryQueue/orbitalQueue are each a SINGLE
  // object (the currently active build) or null; planetaryQueueAll/orbitalQueueAll
  // carry the FULL per-yard queue (active first, then pending — each with its own
  // `id` for cancel), and maxQueueSize is the cap (active + pending). Verified live
  // 2026-07-10 (single active) / 2026-07-12 (queue + ids). We keep the game's raw
  // field names in the slim copy so the server-side parse_shipyard_queue handles
  // this slim body and a direct game body identically.
  function slimShipyard(d) {
    // Full queue entry (active or pending). Pending entries legitimately carry
    // null startsAt/endsAt until they become active, so tolerate missing timing.
    const entry = (q) => (q && q.id != null && q.shipKey) ? {
      id: q.id, shipKey: q.shipKey, shipName: q.shipName || null, quantity: q.quantity || 1,
      startsAt: q.startsAt || null, endsAt: q.endsAt || null,
      isRepair: !!q.isRepair, status: q.status || null,
    } : null;
    // Active-summary object (the old shape the console's summary card reads),
    // now also carrying `id`.
    const one = (q) => (q && q.shipKey) ? {
      id: (q.id != null ? q.id : null), shipKey: q.shipKey, shipName: q.shipName,
      quantity: q.quantity || 1, startsAt: q.startsAt, endsAt: q.endsAt, isRepair: !!q.isRepair,
    } : null;
    const arr = (a) => Array.isArray(a) ? a.map(entry).filter(Boolean) : [];
    const planetaryQueue = one(d && d.planetaryQueue);
    const orbitalQueue = one(d && d.orbitalQueue);
    const planetaryQueueAll = arr(d && d.planetaryQueueAll);
    const orbitalQueueAll = arr(d && d.orbitalQueueAll);
    const maxQueueSize = (d && +d.maxQueueSize) || 0;
    const any = planetaryQueue || orbitalQueue || planetaryQueueAll.length || orbitalQueueAll.length;
    return any ? { planetaryQueue, orbitalQueue, planetaryQueueAll, orbitalQueueAll, maxQueueSize } : null;
  }

  // Own mining outposts: only the fields the map's Empire Console shows —
  // construction job ids, relocation state, rename cooldowns etc. never leave
  // the browser (data minimization, same policy as slimMe).
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

  // SECURITY: the Ops-dispatch allowlist is the EXACT set of Ops endpoints,
  // NOT a broad /api/fleet/* pattern. The old wildcard let a compromised map
  // reach /api/fleet/dispatch (attack another player / gift your resources)
  // through this channel. Adding a genuinely new Ops job type is the one
  // thing that needs a userscript bump — a deliberate, reviewable trade.
  const EXPLORE_DISPATCH_OK = [
    /^\/api\/fleet\/survey$/, /^\/api\/fleet\/collect-debris$/, /^\/api\/fleet\/attack-pirates$/,
    /^\/api\/fleet\/wormhole-run$/, /^\/api\/fleet\/investigate$/, /^\/api\/fleet\/mine$/,
    /^\/api\/planets\/\d+\/shipyard\/repair$/,
  ];
  // → error string (veto) or null (all calls allowed).
  function exploreCallsAllowed(calls) {
    if (!Array.isArray(calls) || !calls.length) return 'no dispatch calls';
    for (const c of calls) {
      if (!c || typeof c.endpoint !== 'string' || !EXPLORE_DISPATCH_OK.some(re => re.test(c.endpoint)))
        return 'endpoint not allowed: ' + (c && c.endpoint);
    }
    return null;
  }

  // The upgrade/cancel routes key on the building DEFINITION id (a small
  // per-type id, e.g. 6) under buildings[].definition.id — NOT the building
  // instance/row id (buildings[].id, which can be 5-digit). Verified live on
  // s0, 2026-07-12; regression-pinned by tests/userscript_engine.mjs.
  // → the endpoint string, or null when the inputs don't form an allowed route.
  function buildingActionEndpoint(planetId, definitionId, action) {
    const ep = '/api/buildings/planets/' + planetId + '/buildings/' + definitionId + '/' + action;
    const ok = action === 'upgrade' ? /^\/api\/buildings\/planets\/\d+\/buildings\/\d+\/upgrade$/
             : action === 'cancel'  ? /^\/api\/buildings\/planets\/\d+\/buildings\/\d+\/cancel$/ : null;
    return (ok && ok.test(ep)) ? ep : null;
  }

  // ── Dispatch_2 prefill (v1.19) — pure matching decisions ──────────────────
  // The DOM driver (prefillInvestigate, below the sentinels) walks the game's
  // OWN Investigate form; these helpers decide WHAT to click/type from plain
  // descriptors so every decision executes in tests. The game UI is localized:
  // the Surveys tab is matched against every label the app bundle ships
  // (extracted 2026-07-16); everything else anchors on locale-independent
  // tokens (system name, ship-icon filename, planet-name prefix). Selector
  // contract: docs/game-actions/investigate-dom-map.md (map repo).
  const SURVEYS_TAB_LABELS = ['Surveys', 'Sondages', 'Sondeos', 'Vermessung',
    'Ricognizioni', 'Сканирование', 'Сканирания', 'Огляди', 'Skanowanie',
    'Průzkumy', 'Prieskum', 'Cercetări', 'Istraživanja', 'Pregledi',
    'Kartoitukset', 'Onderzoeken', 'Reconhecimentos', 'Varreduras', 'Taramalar',
    'Undersøgelser', 'Undersøkelser', 'Undersökningar', 'Vizsgálatok',
    'Έρευνες', '勘测'];
  const DEBRIS_TAB_LABELS = ['Debris', 'Débris', 'Destroços', 'Detriti',
    'Enkaz', 'Escombros', 'Jäänteet', 'Krhotine', 'Puin', 'Razbitine',
    'Resturi', 'Roncsok', 'Skräp', 'Szczątki', 'Trosky', 'Trümmer',
    'Vraggods', 'Vrakrester', 'Συντρίμμια', 'Обломки', 'Отломки', 'Уламки',
    '残骸'];
  // → index of the tab whose (localized) label is in the set, or -1.
  function usPickFleetTab(labels, tabSet) {
    return (labels || []).findIndex(t => (tabSet || []).some(l => String(t || '').includes(l)));
  }
  // → index of the Surveys tab among the fleet-tab label strings, or -1.
  function usPickSurveysTab(labels) {
    return usPickFleetTab(labels, SURVEYS_TAB_LABELS);
  }
  // → index of the survey card whose location token names this system, or -1.
  // Cards: [{location: "Z45-3 · Dead Space", hasInvestigate}]; the token ahead
  // of '·' is the system name. Cards without an Investigate button (expired,
  // already en route, plain combat reports) never match.
  function usPickSurveyCard(cards, systemName) {
    const want = String(systemName || '').trim().toLowerCase();
    if (!want) return -1;
    return (cards || []).findIndex(c => c && c.hasInvestigate
      && String(c.location || '').split('·')[0].trim().toLowerCase() === want);
  }
  // → index of the Send-From option for this planet, or -1. Options read
  // "PlanetName - 401 ly" / "Walla Walla (Home) - 710 ly" / "Colony X - 9 ly";
  // the distance varies per target, so strip it and match the name by
  // exactness first, then the game's known decorations.
  function usPickSourceOption(labels, planetName) {
    const want = String(planetName || '').trim().toLowerCase();
    if (!want) return -1;
    const bare = (labels || []).map(t =>
      String(t || '').replace(/\s*-\s*[\d.,]+\s*ly\s*$/i, '').trim().toLowerCase());
    let i = bare.findIndex(b => b === want);
    if (i < 0) i = bare.findIndex(b => b.replace(/^colony\s+/, '') === want);
    if (i < 0) i = bare.findIndex(b => b.indexOf(want + ' (') === 0);   // "(Home)" etc.
    if (i < 0) i = bare.findIndex(b => b.indexOf(want) !== -1);
    return i;
  }
  // Fleet-fill plan: rows [{icon: ".../missile_cruiser.webp?v=…", max}] from the
  // form + the planned fleet {shipKey: qty} → {plan: [{index, qty}], missing,
  // short}. Rows are matched by ICON FILENAME — it carries the exact game ship
  // key (verified live 2026-07-16) — never by the localized display name.
  // Quantities clamp to the row's max (the form's own availability).
  function usPlanFleetFill(rows, fleet) {
    const plan = [], missing = [], short = [];
    const iconKey = s => String(s || '').split('/').pop().split('?')[0].replace(/\.\w+$/, '');
    const idx = {};
    (rows || []).forEach((r, i) => { const k = iconKey(r && r.icon); if (k && !(k in idx)) idx[k] = i; });
    for (const k in (fleet || {})) {
      const want = Math.floor(+fleet[k] || 0);
      if (want <= 0) continue;
      if (!(k in idx)) { missing.push(k); continue; }
      const i = idx[k];
      const max = Math.max(0, Math.floor(+((rows[i] || {}).max) || 0));
      const qty = Math.min(want, max);
      if (qty < want) short.push(k + ' ' + qty + '/' + want);
      if (qty > 0) plan.push({ index: i, qty });
    }
    return { plan, missing, short };
  }
  // → index of the planet-switcher item for the launch planet, or -1. Items:
  // [{name: "The Unforgiven", system: "[G24-15]"}]. Name match first; a
  // .ps-item-name can render empty mid-load, so fall back to the system token
  // (fromSystem WITHOUT brackets). Two colonies can share a system — the name
  // match always wins when present.
  function usPickPlanetItem(items, planetName, fromSystem) {
    const wantName = String(planetName || '').trim().toLowerCase();
    const wantSys = String(fromSystem || '').trim().toLowerCase();
    let i = wantName ? (items || []).findIndex(it =>
      String((it && it.name) || '').trim().toLowerCase() === wantName) : -1;
    if (i < 0 && wantSys) i = (items || []).findIndex(it =>
      String((it && it.system) || '').replace(/[[\]]/g, '').trim().toLowerCase() === wantSys);
    return i;
  }
  // → index of the galaxy search result whose name IS the system, or -1.
  // Results include planets ("G24-13-P1") — exact match only, never prefix.
  function usPickSearchResult(names, systemName) {
    const want = String(systemName || '').trim().toLowerCase();
    if (!want) return -1;
    return (names || []).findIndex(n => String(n || '').trim().toLowerCase() === want);
  }
  // ==US-ENGINE-END==

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
  // Update DISCOVERY is passive without these (F44): check shortly after load
  // and every 24h in long-lived tabs. Still no auto-INSTALL — the update
  // screen only opens after an explicit confirm (see the security policy).
  setTimeout(() => checkForUpdate(false), 60 * 1000);
  setInterval(() => checkForUpdate(false), 24 * 60 * 60 * 1000);

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
  let _shipyardCache = { at: 0, data: {} };
  // slimPlanetInfo / slimShipyard live in the ==US-ENGINE== block above.
  // Building levels + shipyard queues share the same 5-minute cache — both
  // change slowly enough that a live countdown ticking client-side (from the
  // endsAt each carries) covers the gap between refreshes.
  async function planetInfos(planets) {
    const catalogDue = Date.now() - +(GM_getValue('nx_bcat_at', 0)) > BUILDING_CATALOG_TTL_MS;
    if (!catalogDue && Date.now() - _planetInfoCache.at < PLANET_INFO_TTL_MS) {
      return { infos: _planetInfoCache.data, catalog: null, shipyards: _shipyardCache.data };
    }
    const out = {};
    const shipyards = {};
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
      await sleep(API_DELAY_MS);
      try {
        const sy = slimShipyard(await gget('/api/planets/' + p.id + '/shipyard'));
        if (sy) shipyards[p.id] = sy;
      }
      catch (e) { /* shipyard queue optional */ }
    }
    _planetInfoCache = { at: Date.now(), data: out };
    _shipyardCache = { at: Date.now(), data: shipyards };
    const catalog = Object.values(defs);
    if (catalog.length) GM_setValue('nx_bcat_at', Date.now());
    return { infos: out, catalog: catalog.length ? catalog : null, shipyards };
  }

  // slimOutpost lives in the ==US-ENGINE== block above.

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
      // The same response also carries activeResearches — each entry names its
      // OWN planetId (the lab it's running at), not the query param.
      await sleep(API_DELAY_MS);
      let research = [];
      let researchActive = [];
      const firstPlanet = planets.find(p => p && p.id != null);
      if (firstPlanet) {
        try {
          const rs = await gget('/api/research?planetId=' + firstPlanet.id);
          research = (rs && rs.research) || [];
          researchActive = (rs && rs.activeResearches) || [];
        }
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

      // Data minimization — slimMe (US-ENGINE block) forwards only identity +
      // planet locations, never account details (email, Steam id, billing, …).
      const meSlim = slimMe(me);

      const scriptVersion = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || null;
      const payload = { me: meSlim, planetFleets, planetInfos: pi.infos, missions, maxFleetSlots,
                        spyReports, research, researchActive, battleReports, outposts,
                        shipyard: pi.shipyards, scriptVersion };
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

  // POST to a same-origin game route. `body === null` sends NO body (some game
  // mutations, e.g. building upgrade, are bodyless — content-length 0); any other
  // value (incl. undefined) is JSON-encoded as before.
  async function gamePost(path, body) {
    const opts = { method: 'POST', credentials: 'include', headers: { accept: 'application/json' } };
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    const r = await fetch(path, opts);
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

    // Planet fleets power salvage hauling (available cargo ships), repair
    // (damaged ships), and — v1.17 — the per-planet OPERATIONAL ship counts the
    // map's job gate reads, so a fleet that just landed can crew the next job
    // immediately instead of waiting out the ~30s report cycle. Fetched once
    // per planet for all three uses.
    const fleetByPlanet = {};
    for (const p of planets) {
      try { fleetByPlanet[p.id] = await gget('/api/planets/' + p.id + '/fleet'); } catch (e) { /* skip */ }
    }
    // Operational (undamaged, stationed) counts by ship key — the same
    // availability the map's report path derives, but captured live at scan
    // time. Data minimization: counts only, nothing else from the fleet.
    const shipsFor = (fd) => {
      const out = {};
      ((fd && fd.fleet) || []).forEach(s => {
        const key = s.definition && s.definition.key;
        const op = (+s.quantity || 0) - (+s.damagedQuantity || 0);
        if (key && op > 0) out[key] = (out[key] || 0) + op;
      });
      return out;
    };
    // Utility cargo ships on hand, with EFFECTIVE hold size (base × research cargo
    // bonus; shuttles use the shuttle bonus). The viewer sizes a salvage pickup
    // from these, biggest holds first.
    const haulersFor = (fd) => {
      const cb = +((fd && fd.cargoBonus)) || 0, scb = +((fd && fd.shuttleCargoBonus)) || 0;
      return ((fd && fd.fleet) || [])
        .filter(s => s.definition && s.definition.shipClass === 'utility' && (s.definition.cargoCapacity || 0) > 0)
        .map(s => ({ shipType: s.definition.key, shipDefId: s.shipDefId, available: s.quantity,
          cargo: Math.round(s.definition.cargoCapacity * (1 + (/shuttle/.test(s.definition.key || '') ? scb : cb))),
          // allowedCargo restricts what a hauler can carry (ore_freighter →
          // ore/silicates, tanker → hydrogen; null = unrestricted). The map sizes
          // salvage off only haulers that can carry the whole field. (v1.15)
          allowedCargo: (s.definition.allowedCargo && s.definition.allowedCargo.length) ? s.definition.allowedCargo : null }));
    };
    const result = { planets: planets.map(p => {
      const base = { id: p.id, name: p.name, systemId: p.systemId, systemName: p.systemName,
                     systemX: p.systemX, systemY: p.systemY, isHomeworld: !!p.isHomeworld,
                     ships: shipsFor(fleetByPlanet[p.id]) };
      if (want('salvage')) base.haulers = haulersFor(fleetByPlanet[p.id]);
      return base;
    }) };

    // v1.18: the fleets-out counter, captured live at scan time. Mirrors the
    // report path's server-side rule (_count_active_missions in collector.py):
    // EVERY mission still holding a slot counts — until its returnArrivesAt is
    // in the past — regardless of type or composition. Rides the scan so the
    // map's "N/M out" updates with every re-scan (incl. the automatic one
    // ~10s after a fleet lands) instead of lagging the ~30s report cycle.
    try {
      const fm = await gget('/api/fleet/missions');
      const nowMs = Date.now();
      result.fleetsOut = ((fm && fm.missions) || []).filter(m => {
        if (!m) return false;
        const ra = m.returnArrivesAt ? +new Date(m.returnArrivesAt) : NaN;
        return !(isFinite(ra) && nowMs > ra);   // already home — slot freed
      }).length;
      if (fm && fm.maxFleetSlots > 0) result.maxFleetSlots = fm.maxFleetSlots;
    } catch (e) { /* counter data optional */ }

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
  // { calls: [{ endpoint, body }, ...] } (repair sends several). The security
  // allowlist (EXPLORE_DISPATCH_OK + exploreCallsAllowed) lives in the
  // ==US-ENGINE== block above, where tests execute it.
  function exploreDispatch(req) {
    const b = req || {};
    const calls = Array.isArray(b.calls) ? b.calls
      : (b.endpoint ? [{ endpoint: b.endpoint, body: b.body }] : []);
    const veto = exploreCallsAllowed(calls);
    if (veto) return Promise.reject(new Error(veto));
    return Promise.all(calls.map(c => gamePost(c.endpoint, c.body || {})))
      .then(results => (results.length === 1 ? results[0] : { results }));
  }

  // ── Colony build / upgrade (viewer build planner, v1.11) ───────────────────
  // The viewer sends { planetId, buildingKey }. The report doesn't carry the
  // building SLOT id, so resolve it live from /api/planets, then POST the upgrade
  // with an EMPTY body (matching the game). One slot per building type (level 0 =
  // unbuilt) means this covers BOTH upgrading an existing building AND building a
  // new one. SELF-OWNED planets only, and the endpoint is regex-pinned to the
  // upgrade route — fail closed. No in-game confirm: a build on your OWN colony
  // spends only your own resources and can't be used to rob you or attack anyone
  // (unlike a fleet dispatch), so it stays in the "safe self-action" tier.
  async function buildUpgrade(req) {
    const b = req || {};
    const pid = +b.planetId;
    const key = String(b.buildingKey || '');
    if (!pid || !key) return Promise.reject(new Error('bad build request'));
    const owned = await ownedPlanetIds();
    if (!owned.has(pid)) return Promise.reject(new Error('planet not owned — build refused'));
    const d = await gget('/api/planets/' + pid);
    const slot = ((d && d.buildings) || []).find(x => x && x.definition && x.definition.key === key);
    // DEFINITION id, not instance id — see buildingActionEndpoint (US-ENGINE).
    const defId = slot && slot.definition && slot.definition.id;
    if (defId == null) return Promise.reject(new Error('no building definition id for "' + key + '"'));
    const endpoint = buildingActionEndpoint(pid, defId, 'upgrade');
    if (!endpoint) return Promise.reject(new Error('endpoint not allowed'));   // defense in depth
    return gamePost(endpoint, null);   // bodyless POST
  }

  // ── Colony build cancel (viewer "✕ Cancel" on a construction card, v1.13) ────
  // Same slot resolution as buildUpgrade (definition.id), endpoint regex-pinned to
  // the CANCEL route. Self-owned planets only. A cancel refunds materials to your
  // OWN colony and can't touch anyone else, so it stays in the safe self-action
  // tier (no in-game confirm), matching build-upgrade.
  async function buildCancel(req) {
    const b = req || {};
    const pid = +b.planetId;
    const key = String(b.buildingKey || '');
    if (!pid || !key) return Promise.reject(new Error('bad build-cancel request'));
    const owned = await ownedPlanetIds();
    if (!owned.has(pid)) return Promise.reject(new Error('planet not owned — cancel refused'));
    const d = await gget('/api/planets/' + pid);
    const slot = ((d && d.buildings) || []).find(x => x && x.definition && x.definition.key === key);
    const defId = slot && slot.definition && slot.definition.id;
    if (defId == null) return Promise.reject(new Error('no building definition id for "' + key + '"'));
    const endpoint = buildingActionEndpoint(pid, defId, 'cancel');
    if (!endpoint) return Promise.reject(new Error('endpoint not allowed'));   // defense in depth
    return gamePost(endpoint, null);   // bodyless POST
  }

  // ── Colony ship building (viewer shipyard planner, v1.12) ──────────────────
  // shipyard-info: live buildable-ship list for a colony (the report only carries
  // the ACTIVE queue, not the catalog). Filtered to what can actually be built
  // here (available && researchMet && shipyardMet) and to colony yards (Planetary
  // / Orbital — Moon Dockyard is moon-only). Costs are FINAL per-unit values.
  function _shipCost(s) {
    const c = {};
    if (+s.costOre) c.ore = +s.costOre;
    if (+s.costSilicates) c.silicates = +s.costSilicates;
    if (+s.costHydrogen) c.hydrogen = +s.costHydrogen;
    if (+s.costAlloys) c.alloys = +s.costAlloys;
    Object.entries(s.rareCosts || {}).forEach(([k, v]) => { if (+v) c[k] = +v; });
    return c;
  }
  async function shipyardInfo(req) {
    const pid = +((req || {}).planetId);
    if (!pid) return Promise.reject(new Error('bad shipyard-info request'));
    const d = await gget('/api/planets/' + pid + '/shipyard');
    const yard = { 'Planetary Shipyard': 'planetary', 'Orbital Shipyard': 'orbital' };
    const ships = ((d && d.ships) || [])
      .filter(s => s && s.available && s.researchMet && s.shipyardMet && yard[s.shipyardName])
      .map(s => ({ id: s.id, key: s.key, name: s.name, yard: yard[s.shipyardName],
                   cost: _shipCost(s), buildTime: +s.buildTime || 0, sortOrder: +s.sortOrder || 0 }));
    // Also hand back the live per-yard queue (active first, then pending — each
    // with its `id`) so the ship panel can show/cancel the current queue without
    // waiting on the next slow report. Same slim shape the report carries.
    const sy = slimShipyard(d) || {};
    return { ships, planetaryActive: !!(d && d.planetaryQueue), orbitalActive: !!(d && d.orbitalQueue),
             maxQueueSize: (d && d.maxQueueSize) || 0,
             planetaryQueue: sy.planetaryQueueAll || [], orbitalQueue: sy.orbitalQueueAll || [] };
  }
  // ship-build: POST the shipyard build. Self-owned planets only; the endpoint is
  // regex-pinned; body is { shipDefId, quantity } (shipDefId = ships[].id).
  async function shipBuild(req) {
    const b = req || {};
    const pid = +b.planetId, shipDefId = +b.shipDefId;
    const quantity = Math.max(1, Math.floor(+b.quantity || 1));
    if (!pid || !shipDefId) return Promise.reject(new Error('bad ship-build request'));
    const owned = await ownedPlanetIds();
    if (!owned.has(pid)) return Promise.reject(new Error('planet not owned — build refused'));
    const endpoint = '/api/planets/' + pid + '/shipyard/build';
    if (!/^\/api\/planets\/\d+\/shipyard\/build$/.test(endpoint))
      return Promise.reject(new Error('endpoint not allowed'));   // defense in depth
    return gamePost(endpoint, { shipDefId, quantity });
  }
  // ship-cancel: cancel one queued/active shipyard build by its queue-entry id
  // (POST /shipyard/cancel/{queueId} — refunds 100% for a queued build, 90% for
  // the active one, to your OWN colony). The id comes from the report's queue
  // entries — no slot resolution needed. Self-owned planets only, endpoint
  // regex-pinned; a refund can't touch anyone else, so it stays in the safe
  // self-action tier (no in-game confirm), like build-cancel.
  // The POST is BODYLESS (v1.18.1): the game's own UI sends content-length 0
  // (live capture 2026-07-15), and with a JSON `{}` body the game answered 200
  // WITHOUT cancelling — same trap as the building-cancel route.
  async function shipCancel(req) {
    const b = req || {};
    const pid = +b.planetId, queueId = +b.queueId;
    if (!pid || !queueId) return Promise.reject(new Error('bad ship-cancel request'));
    const owned = await ownedPlanetIds();
    if (!owned.has(pid)) return Promise.reject(new Error('planet not owned — cancel refused'));
    const endpoint = '/api/planets/' + pid + '/shipyard/cancel/' + queueId;
    if (!/^\/api\/planets\/\d+\/shipyard\/cancel\/\d+$/.test(endpoint))
      return Promise.reject(new Error('endpoint not allowed'));   // defense in depth
    return gamePost(endpoint, null);   // BODYLESS — content-length 0, like the game UI
  }

  // ── Dispatch_2: prefill the game's OWN Investigate form (v1.19) ────────────
  // Walks the live UI (fleet page → Surveys tab → the anomaly's card → modal),
  // selects the source planet and types the ship counts, then STOPS — the user
  // reviews and clicks the game's own confirm. This RPC never presses the
  // confirm button and never calls a game API, so it stays in the safe tier.
  // Selector contract + proven techniques (native value setter for React
  // inputs, async menu mount): docs/game-actions/investigate-dom-map.md.
  function _pfWait(test, ms, step) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        let v = null;
        try { v = test(); } catch (e) { /* keep polling */ }
        if (v) return resolve(v);
        if (Date.now() - t0 > ms) return reject(new Error('game UI never showed: ' + step));
        setTimeout(poll, 150);
      })();
    });
  }
  // React ignores plain `.value =` writes — go through the native setter and
  // fire `input` so its onChange sees the change (proven live 2026-07-16).
  function _pfSetInput(inp, val) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, String(val));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // The location dropdown needs the full press sequence; its menu mounts async.
  function _pfPress(el) {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
  }
  // Shared staging steps — the game reuses ONE modal pattern (.spy-modal with
  // a .location-select source + .ship-select-row steppers) across the fleet
  // page's card actions: investigate (v1.19) and debris salvage (v1.21).
  // Every step stops short of the confirm button.
  // Fleet page → the given tab → the system's card → its action button → modal.
  async function _pfOpenCardModal(o) {
    if (!document.querySelector('.fleet-page')) {
      const nav = document.querySelector('a.sidebar-link[href="/fleet"]');
      if (!nav) throw new Error('game sidebar not found — is the game tab fully loaded?');
      nav.click();
      await _pfWait(() => document.querySelector('.fleet-page'), 8000, 'fleet page');
    }
    const tabs = [...document.querySelectorAll('button.fleet-tab')];
    const ti = usPickFleetTab(tabs.map(t => t.textContent || ''), o.tabLabels);
    if (ti < 0) throw new Error(o.tabName + ' tab not found on the fleet page');
    tabs[ti].click();
    await _pfWait(() => document.querySelector(o.paneSel), 6000, o.tabName + ' pane');
    const cards = [...document.querySelectorAll(o.cardSel)];
    const ci = usPickSurveyCard(cards.map(c => {
      const loc = c.querySelector(o.locSel);
      return { location: (loc && (loc.getAttribute('title') || loc.textContent)) || '',
               hasInvestigate: !!c.querySelector(o.btnSel) };
    }), o.systemName);
    if (ci < 0) throw new Error(o.noCardMsg);
    cards[ci].querySelector(o.btnSel).click();
    return _pfWait(() => document.querySelector('.spy-modal'), 6000, o.tabName + ' modal');
  }
  // Send From — skip when the game already preselected the right planet.
  async function _pfSelectSource(modal, fromPlanet) {
    const curLabel = () => {
      const el = modal.querySelector('.location-select-row-label');
      return (el && el.textContent) || '';
    };
    const optsOf = () => [...document.querySelectorAll('.location-select-menu .location-select-option')];
    if (usPickSourceOption([curLabel()], fromPlanet) === 0) return;
    _pfPress(modal.querySelector('.location-select-button'));
    await _pfWait(() => optsOf().length, 4000, 'source planet menu');
    const opts = optsOf();
    const oi = usPickSourceOption(opts.map(o => o.textContent || ''), fromPlanet);
    if (oi < 0) throw new Error('source planet "' + fromPlanet + '" is not in the Send From list');
    opts[oi].click();
    await _pfWait(() => !optsOf().length, 4000, 'menu close');
    await new Promise(r => setTimeout(r, 350));   // rows re-render with the new source's availability
  }
  // Ship counts — rows matched by icon filename (= game ship key), clamped to
  // the form's own max. The confirm button is NEVER touched.
  async function _pfFillFleet(modal, fleet, fromPlanet) {
    const rowEls = [...modal.querySelectorAll('.ship-select-row')];
    const descs = rowEls.map(r => {
      const img = r.querySelector('.ship-select-name img');
      const inp = r.querySelector('input[type="number"]');
      return { icon: (img && img.getAttribute('src')) || '',
               max: (inp && inp.getAttribute('max')) || 0 };
    });
    const fill = usPlanFleetFill(descs, fleet);
    if (!fill.plan.length) throw new Error('none of the planned ships are available at ' + fromPlanet);
    let placed = 0;
    for (const p of fill.plan) {
      _pfSetInput(rowEls[p.index].querySelector('input[type="number"]'), p.qty);
      placed += p.qty;
      await new Promise(r => setTimeout(r, 60));   // let React commit between rows
    }
    return { placed, missing: fill.missing, short: fill.short };
  }
  async function prefillInvestigate(req) {
    const b = req || {};
    const systemName = String(b.systemName || '').trim();
    const fromPlanet = String(b.fromPlanet || '').trim();
    if (!systemName || !fromPlanet) throw new Error('bad prefill request');
    const modal = await _pfOpenCardModal({
      tabLabels: SURVEYS_TAB_LABELS, tabName: 'Surveys', paneSel: '.surveys-tab',
      cardSel: '.report-card.rep-survey', locSel: '.rep-location', btnSel: '.investigate-btn',
      systemName,
      noCardMsg: 'no investigable anomaly for ' + systemName +
        ' in the game’s survey list — it may have expired or already be en route',
    });
    await _pfSelectSource(modal, fromPlanet);
    return _pfFillFleet(modal, b.fleet || {}, fromPlanet);
  }
  // ── Dispatch_2: prefill the debris-salvage form (v1.21) ─────────────────────
  // Fleet → Debris tab → the system's debris card → "collect" modal (same
  // .spy-modal pattern as investigate: Send From + cargo-ship steppers; the
  // form itself offers only cargo-capable ships). Fill and STOP — the user
  // clicks the game's "Send N ships". If a system holds several debris fields,
  // the first card with a collect button is staged (the user can retarget in
  // the open form). No game API is called.
  async function prefillSalvage(req) {
    const b = req || {};
    const systemName = String(b.systemName || '').trim();
    const fromPlanet = String(b.fromPlanet || '').trim();
    if (!systemName || !fromPlanet) throw new Error('bad prefill request');
    const modal = await _pfOpenCardModal({
      tabLabels: DEBRIS_TAB_LABELS, tabName: 'Debris', paneSel: '.debris-tab',
      cardSel: '.debris-tab .expedition-mission-card', locSel: '.debris-system-link',
      btnSel: '.collect-salvage-btn', systemName,
      noCardMsg: 'no collectable debris for ' + systemName +
        ' in the game’s debris list — it may have expired or been collected',
    });
    await _pfSelectSource(modal, fromPlanet);
    return _pfFillFleet(modal, b.fleet || {}, fromPlanet);
  }

  // ── Dispatch_2: stage a SURVEY in the game UI (v1.20) ───────────────────────
  // Survey has no form at all: the galaxy panel's "Survey System" button
  // launches a real fleet from the game's ACTIVE PLANET on the FIRST CLICK —
  // no modal, no confirm (verified live 2026-07-16, the hard way). So this RPC
  // does everything UP TO that click: set the active planet to the job's
  // launch planet (the survey departs from whatever planet is focused), open
  // the target system's galaxy panel, and STOP. It must NEVER click
  // button.survey-btn. Selector contract: docs/game-actions/investigate-dom-map.md.
  async function prefillSurvey(req) {
    const b = req || {};
    const systemName = String(b.systemName || '').trim();
    const fromPlanet = String(b.fromPlanet || '').trim();
    const fromSystem = String(b.fromSystem || '').trim();
    if (!systemName || !fromPlanet) return Promise.reject(new Error('bad prefill request'));
    // 1. Active planet — the survey's launch source (no in-form selector exists).
    const curPlanet = () => {
      const el = document.querySelector('.planet-switcher .ps-name');
      return ((el && el.textContent) || '').trim();
    };
    if (curPlanet().toLowerCase() !== fromPlanet.toLowerCase()) {
      const swBtn = document.querySelector('button.planet-switcher-btn');
      if (!swBtn) throw new Error('planet switcher not found — is the game tab fully loaded?');
      _pfPress(swBtn);
      await _pfWait(() => document.querySelector('.planet-switcher-dropdown'), 4000, 'planet switcher');
      const items = [...document.querySelectorAll('.planet-switcher-dropdown .ps-item')];
      const pi = usPickPlanetItem(items.map(it => {
        const nm = it.querySelector('.ps-item-name'), sy = it.querySelector('.ps-item-system');
        return { name: (nm && nm.textContent) || '', system: (sy && sy.textContent) || '' };
      }), fromPlanet, fromSystem);
      if (pi < 0) throw new Error('launch planet "' + fromPlanet + '" is not in the planet switcher');
      items[pi].click();
      await _pfWait(() => curPlanet().toLowerCase() === fromPlanet.toLowerCase()
        || !document.querySelector('.planet-switcher-dropdown'), 5000, 'active-planet switch');
      await new Promise(r => setTimeout(r, 300));
    }
    // 2. The galaxy page — SPA-navigate; a full page load would destroy the
    // JS context running this very RPC.
    if (!document.querySelector('.galaxy-search-input')) {
      const nav = document.querySelector('a.sidebar-link[href^="/galaxy"]');
      if (!nav) throw new Error('galaxy sidebar link not found');
      nav.click();
      await _pfWait(() => document.querySelector('.galaxy-search-input'), 8000, 'galaxy page');
    }
    // 3. Find the system: type its name, click the EXACT-match result row
    // (results include planets like "G24-13-P1" — prefix matches are wrong).
    _pfSetInput(document.querySelector('.galaxy-search-input'), systemName);
    await _pfWait(() => document.querySelector('.galaxy-search-result'), 5000, 'search results');
    const rows = [...document.querySelectorAll('.galaxy-search-result')];
    const ri = usPickSearchResult(rows.map(r => {
      const n = r.querySelector('.search-result-name');
      return (n && n.textContent) || '';
    }), systemName);
    if (ri < 0) throw new Error('system "' + systemName + '" not found in the galaxy search');
    rows[ri].click();
    await _pfWait(() => document.querySelector('.panel-survey-section'), 6000, 'system panel');
    // 4. STOP. Report readiness; the user clicks "Survey System" themselves.
    const ind = document.querySelector('.survey-status-indicator');
    return { ready: !ind, status: ind ? ind.textContent.trim() : null };
  }

  const RPC = { 'fuel-estimate': fuelEstimate, 'launch-mission': launchMission, 'recall-mission': recallMission,
                'planet-info': planetInfo, 'explore-scan': exploreScan, 'explore-dispatch': exploreDispatch,
                'build-upgrade': buildUpgrade, 'build-cancel': buildCancel, 'shipyard-info': shipyardInfo,
                'ship-build': shipBuild, 'ship-cancel': shipCancel, 'prefill-investigate': prefillInvestigate,
                'prefill-survey': prefillSurvey, 'prefill-salvage': prefillSalvage };

  const _winHandled = new Map();   // window-path request id -> reply (dedup, F40)
  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d.source !== 'nexstar-viewer' || !okOrigin(ev.origin)) return;   // only our viewer, only trusted origins
    const reply = (msg) => {
      try { ev.source.postMessage(Object.assign({ source: 'nexstar-relay', id: d.id }, msg), ev.origin); }
      catch (e) { /* source/window gone */ }
    };
    // Pong carries the script version (v1.16+): the viewer's RPC_MIN_VER
    // handshake reads it to fail fast instead of timing out (F13/F37).
    if (d.kind === 'ping') { reply({ kind: 'pong', version: CUR_VERSION }); return; }
    if (!RPC[d.kind]) {
      // Old scripts dropped unknown kinds silently — the viewer saw a
      // misleading 20s "not logged in" timeout. Say what's actually wrong.
      if (d.id) reply({ kind: d.kind + '-result', ok: false,
        error: 'reporter v' + CUR_VERSION + ' does not support "' + d.kind + '" — update the reporter userscript' });
      return;
    }
    // Resend nudges must not re-RUN a mutation (F40: recall-mission could
    // re-fire every 700ms): first arrival executes; duplicates get the cached
    // reply, or nothing while the original is still in flight (it will reply).
    if (d.id && _winHandled.has(d.id)) {
      const cached = _winHandled.get(d.id);
      if (cached) reply(cached);
      return;
    }
    if (d.id) _winHandled.set(d.id, null);   // in-flight marker
    let msg;
    try { msg = { kind: d.kind + '-result', ok: true, data: await RPC[d.kind](d.body) }; }
    catch (e) { msg = { kind: d.kind + '-result', ok: false, error: String((e && e.message) || e) }; }
    if (d.id) { _winHandled.set(d.id, msg); setTimeout(() => _winHandled.delete(d.id), 60000); }
    reply(msg);
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
      if (!l || l.id === TAB_ID || Date.now() - l.ts > LEADER_TTL) {
        const wasLeader = !!l && l.id === TAB_ID;
        GM_setValue('nx_leader', { id: TAB_ID, ts: Date.now() });
        if (!wasLeader) {
          // Just took over. A one-shot command dropped during the no-leader
          // window (old leader closed/reloaded, TTL not yet expired) would
          // otherwise vanish into a timeout (F16) — pick it up if still
          // fresh. Deferred a tick so boot-time claims run after the RPC
          // table exists.
          const req = GM_getValue('nx_req', null);
          if (req && req.ts && Date.now() - req.ts < 20000) setTimeout(() => handleGmReq(req), 0);
        }
      }
    } catch (e) { /* */ }
  }
  claimLeader();
  setInterval(claimLeader, 5000);
  const amLeader = () => { const l = GM_getValue('nx_leader', null); return !!l && l.id === TAB_ID; };
  const _gmHandled = new Set();   // request ids this tab already ran (resend nudges)
  async function handleGmReq(req) {
    if (!req || !req.id || !req.kind) return;
    const respond = (msg) => {
      GM_setValue('nx_res_' + req.id, Object.assign({ id: req.id }, msg));
      setTimeout(() => { try { GM_deleteValue('nx_res_' + req.id); } catch (e) { /* */ } }, 30000);
    };
    // Ping is answered by EVERY game tab, leader or not: the probe means "does
    // a game tab exist", and the old leader-gated pong went silent during
    // leader-election gaps — the viewer showed no link right after a game-tab
    // reload (F16). Duplicate pongs collapse onto the same nx_res_<id> key.
    // Carries the version for the viewer's RPC_MIN_VER handshake (F13/F37).
    if (req.kind === 'ping') { respond({ kind: 'pong', ok: true, version: CUR_VERSION }); return; }
    if (!amLeader() || _gmHandled.has(req.id)) return;
    _gmHandled.add(req.id);
    setTimeout(() => _gmHandled.delete(req.id), 60000);
    let msg;
    if (!RPC[req.kind]) {
      // Old scripts dropped unknown kinds silently — misleading 20s timeout
      // viewer-side. Reply with what's actually wrong instead.
      msg = { kind: req.kind + '-result', ok: false,
              error: 'reporter v' + CUR_VERSION + ' does not support "' + req.kind + '" — update the reporter userscript' };
    } else {
      try { msg = { kind: req.kind + '-result', ok: true, data: await RPC[req.kind](req.body) }; }
      catch (e) { msg = { kind: req.kind + '-result', ok: false, error: String((e && e.message) || e) }; }
    }
    respond(msg);
    // Exactly-once across tab reloads: _gmHandled is in-memory only, so a NEW
    // leader (this tab reloaded, or a handoff pickup) must not find and
    // re-run an already-answered request — clear it from script storage.
    try { GM_deleteValue('nx_req'); } catch (e) { /* */ }
  }
  GM_addValueChangeListener('nx_req', (k, o, req) => { handleGmReq(req); });

  announceReady();
})();
