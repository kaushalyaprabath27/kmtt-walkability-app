/* =====================================================================
   KMTT Walkability Improvement Feasibility Study: pedestrian interview
   ---------------------------------------------------------------------
   One form per interview. Only the enumerator is set at the start; every
   saved interview records its own GPS position, date, time and an
   automatic Interview ID. Questions run in three sections: about the
   respondent, this trip, and the walking path.

   Offline-first, like the other survey apps: each saved interview goes to
   localStorage first and is sent to the Apps Script backend in batches
   (every 15 s and on reconnect). The half-filled form is kept as a draft.
   ===================================================================== */

const CONFIG = Object.assign({
    appsScriptUrl: '',
    googlePlacesApiKey: '',
    placeSearchBbox: [79.4, 5.8, 82.0, 10.0],
    placeSearchCountry: 'lk',
    presetLocations: []
}, window.KMTT_CONFIG || {});

const PLACEHOLDER_URL = 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE';
const SURVEY_TYPE = 'kmtt-walkability';
// v3: revised questionnaire (sections, trip category, modes to / from the
// walking trip, walking-path difficulties; no route map). v2: bus terminal +
// route, notes.
const SYNC_ACTION = 'submit_kmtt_v3';
const BATCH_SIZE = 50;
const SYNC_INTERVAL_MS = 15000;

const QUEUE_KEY = 'kmtt_queue';      // interviews waiting to sync
const BACKUP_KEY = 'kmtt_backup';    // every interview saved on this device
const SESSION_KEY = 'kmtt_session';  // enumerator
const DRAFT_KEY = 'kmtt_draft';      // the form currently being filled in
const HISTORY_KEY = 'kmtt_history';  // undo stack (eventIds)
const RECENT_KEY = 'kmtt_recent';    // places used before on this device
const SEQ_KEY = 'kmtt_seq';          // Interview ID counters per enumerator and day
const THEME_KEY = 'kmtt_theme';

// ---------------------------------------------------------------------
// The questionnaire. Edit option lists here; the form is built from this.
//   place  - text with place suggestions (keeps coordinates when picked)
//            presets: true offers the study-area list from config.js first
//            multi: true collects several places (shown as removable chips)
//   route  - map: tap points, the walking route is drawn along the streets
//            nearby: true ranks places close to the site first
//            recent: true also offers values used before at this location
//            recentGroup: fields with the same group share those values
//            presets: true = study-area locations; or the name of another list
//              in config.js (e.g. 'busRoutes'), with presetSub as its caption
//            mapSearch: false = only the lists / typed text, no map search
//            cities: true = Sri Lankan cities and towns first, then other places
//            cityRoutes: 'from' / 'to' = every Sri Lankan town as a bus route
//              ("Badulla – Kandy" / "Kandy – Badulla")
//            icon: Font Awesome name for the box icon
//   single - pick one        multi - pick any number
//   other: true adds "Other" with a text box
//   notes: 'placeholder' adds a free-text box under the options
//   exclusive: an option that clears the others when picked (e.g. 'None')
//   exclusive: may also be a list (e.g. ['None', 'Prefer not to answer'])
//   max: n     at most n options in a multi question ("select up to two")
//   optionsFrom: 'id'  a single question whose options are the answers ticked
//              in another question (exclude: [...], emptyOption: '...')
//   optional: true  not counted in progress and never listed as missing
//   showIf: answers => boolean  shows the question only when true (numbered
//   as a sub-question, e.g. 5a, 5b, and not counted while hidden)
//   sub: true  numbered as a sub-question (e.g. 1a) but always shown
//   main: true a conditional question that keeps its own number (e.g. 16)
//   section: 'Title'  starts a new section of the form with this heading
// An option can carry an icon: a Font Awesome name or inline SVG.
// ---------------------------------------------------------------------
const TUKTUK_SVG = '<svg class="svg-icon" viewBox="1.8 1.4 28.4 23" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="M2.5 13V6.2Q2.5 2 7 2H24.2Q26.4 2 26.7 3.8L27.9 12.4H26.1L25.1 4.3H7.6Q5.3 4.3 5.3 6.6V13Z"/><path d="M3.5 12.6H27.4Q29.7 12.6 29.7 15Q29.7 16.4 28.6 17.6L27.8 18.6H10.77A3.6 3.6 0 0 0 5.23 18.6H4.6Q2.4 18.6 2.4 16.2V13.7Q2.4 12.6 3.5 12.6ZM27.5 14.6a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0Z"/><path d="M22.6 12.6L24.6 8.4L25.5 8.8L23.8 12.6Z"/><path d="M5 20.9a3 3 0 1 0 6 0a3 3 0 1 0 -6 0ZM6.9 20.9a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0ZM24 21.4a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0ZM25.6 21.4a0.9 0.9 0 1 0 1.8 0a0.9 0.9 0 1 0 -1.8 0Z"/><path d="M26.05 18.4H26.95V20.5H26.05Z"/></svg>';

// Travel modes for getting to / from the walking trip ('None' = walking only).
const MODES = [
    ['Bus', 'fa-bus'],
    ['Train', 'fa-train'],
    ['Three-wheeler', TUKTUK_SVG],
    ['Car / Jeep', 'fa-car-side'],
    ['Motorcycle', 'fa-motorcycle'],
    ['Bicycle', 'fa-bicycle'],
    ['Taxi / ride-hailing', 'fa-taxi'],
    ['School / office van', 'fa-van-shuttle']
];
const SAFETY_DIFFICULTY = 'Personal safety / security concern';

const has = (a, id, v) => Array.isArray(a[id]) && a[id].includes(v);
const answeredNot = (a, id, v) => Array.isArray(a[id]) && a[id].length > 0 && !a[id].includes(v);

const FORM = [
    // ---------------- A. About you ----------------
    { id: 'gender', section: 'About you', label: 'Gender', type: 'single', hint: 'Observe', options: ['Male', 'Female'] },
    { id: 'age', label: 'What is your age?', type: 'single', options: ['Under 18', '18–40', '41–60', 'Over 60'] },
    {
        id: 'vulnerability', label: 'Vulnerability (observed)', type: 'multi', exclusive: 'None',
        hint: 'Tick if it applies', options: [['Blind', 'fa-eye-slash'], ['Challenged with mobility', 'fa-wheelchair'], ['None', 'fa-circle-check']]
    },
    {
        id: 'difficulties', label: 'Do you have any of the following difficulties?', type: 'multi', grid: true,
        exclusive: ['None', 'Prefer not to answer'], hint: 'Select all that apply',
        options: [
            'Difficulty walking or using steps',
            'Difficulty seeing, even when wearing glasses',
            'Difficulty hearing, even when using a hearing aid',
            'Other difficulty affecting movement or use of pedestrian facilities',
            'None',
            'Prefer not to answer'
        ]
    },
    {
        id: 'purpose', label: 'What is the main purpose of this trip?', type: 'single', other: true, grid: true,
        options: [
            ['Work', 'fa-briefcase'],
            ['Business (including vending)', 'fa-store'],
            ['Education', 'fa-graduation-cap'],
            ['Healthcare', 'fa-hospital-user'],
            ['Shopping', 'fa-bag-shopping'],
            ['Religious activity', 'fa-place-of-worship'],
            ['Recreation / tourism', 'fa-camera'],
            ['Accompanying / assisting someone', 'fa-people-arrows'],
            ['Travel interchange', 'fa-shuffle']
        ]
    },
    {
        id: 'category', label: 'Which best describes you on this trip?', type: 'single', other: true, grid: true,
        options: [
            ['Resident', 'fa-house'],
            ['Worker / employee', 'fa-briefcase'],
            ['School child', 'fa-child'],
            ['University student', 'fa-graduation-cap'],
            ['Other student', 'fa-book'],
            ['Patient', 'fa-hospital-user'],
            ['Shopper / customer', 'fa-bag-shopping'],
            ['Tourist / visitor', 'fa-camera'],
            ['Pilgrim', 'fa-place-of-worship'],
            ['Passing through', 'fa-person-walking-arrow-right'],
            ['Vendor / trader', 'fa-store']
        ]
    },
    {
        id: 'accompanying', label: 'Are you accompanying or assisting anyone on this trip?', type: 'multi', other: true, exclusive: 'No',
        hint: 'Select all that apply',
        options: [['No', 'fa-user'], ['Baby', 'fa-baby'], ['Young child', 'fa-child'], ['Older person', 'fa-person-cane'], ['Person requiring mobility assistance', 'fa-wheelchair']]
    },

    // ---------------- B. This trip ----------------
    {
        id: 'origin', section: 'This trip', label: 'Where did this walking trip start?', type: 'place', presets: true, nearby: true, recent: true, recentGroup: 'walkEnds',
        hint: 'Place / landmark where they started walking', placeholder: 'Start typing a place or landmark'
    },
    {
        id: 'destination', label: 'Where will this walking trip end?', type: 'place', presets: true, nearby: true, recent: true, recentGroup: 'walkEnds',
        hint: 'Place / landmark where they will stop walking', placeholder: 'Start typing a place or landmark'
    },
    {
        id: 'frequency', label: 'How often do you walk along this path?', type: 'single',
        options: ['Daily', 'Several days a week', 'About once a week', 'Less frequently', 'First visit']
    },
    {
        id: 'startMode', label: 'How did you get to the start of this walking trip?', type: 'single', other: true, grid: true,
        hint: 'The mode used just before walking', options: [['Walked all the way', 'fa-person-walking']].concat(MODES)
    },
    // Bus stand and route: asked only when they came / will go by bus.
    {
        id: 'startBusTerminal', label: 'Which bus stand / terminal did you get off at?', type: 'place', presets: true, nearby: true, recent: true, recentGroup: 'busTerminal',
        icon: 'fa-bus-simple', showIf: a => a.startMode === 'Bus', placeholder: 'Start typing a bus stand / terminal'
    },
    {
        id: 'startBusRoute', label: 'Which bus route did you come on?', type: 'place', presets: 'busRoutes', presetSub: 'Bus route', mapSearch: false, cityRoutes: 'from',
        recent: true, recentGroup: 'busRoute', icon: 'fa-bus',
        showIf: a => a.startMode === 'Bus', hint: 'e.g. Colombo – Kandy', placeholder: 'Type a town, e.g. Colombo'
    },
    {
        id: 'endMode', label: 'How will you travel after the end of this walking trip?', type: 'single', other: true, grid: true,
        hint: 'The mode used just after walking', options: [['Will walk all the way', 'fa-person-walking']].concat(MODES, [['Not yet decided', 'fa-circle-question']])
    },
    {
        id: 'endBusTerminal', label: 'Which bus stand / terminal will you board at?', type: 'place', presets: true, nearby: true, recent: true, recentGroup: 'busTerminal',
        icon: 'fa-bus-simple', showIf: a => a.endMode === 'Bus', placeholder: 'Start typing a bus stand / terminal'
    },
    {
        id: 'endBusRoute', label: 'Which bus route will you take?', type: 'place', presets: 'busRoutes', presetSub: 'Bus route', mapSearch: false, cityRoutes: 'to',
        recent: true, recentGroup: 'busRoute', icon: 'fa-bus',
        showIf: a => a.endMode === 'Bus', hint: 'e.g. Kandy – Kurunegala', placeholder: 'Type a town, e.g. Kurunegala'
    },
    {
        id: 'routeReason', label: 'Why did you choose this walking path?', type: 'multi', other: true, grid: true, max: 2,
        hint: 'Select up to two',
        options: [
            ['Shortest', 'fa-ruler'],
            ['Easier to walk', 'fa-person-walking'],
            ['Safer crossing', 'fa-shield-halved'],
            ['Access to shops / services', 'fa-store'],
            ['Shade / shelter', 'fa-umbrella'],
            ['Avoid steps', 'fa-stairs'],
            ['Only practical route', 'fa-route']
        ]
    },
    {
        id: 'walkTime', label: 'About how long is your walk on this trip?', type: 'single',
        hint: 'Include the part still to walk',
        options: ['Less than 5 minutes', '5–10 minutes', '10–15 minutes', 'Over 15 minutes', 'Do not know']
    },

    // ---------------- C. The walking path ----------------
    {
        id: 'pathDifficulties', section: 'The walking path', label: 'What difficulties did you find when walking this path?', type: 'multi', other: true, grid: true,
        exclusive: 'None', hint: 'Select all that apply', notes: 'Details in the respondent’s words (optional)',
        options: [
            ['Vehicles parked on the walking path', 'fa-car-side'],
            ['Motorcycles / three-wheelers riding on the path', 'fa-motorcycle'],
            ['Goods or vendors blocking the path', 'fa-store'],
            ['Path too narrow', 'fa-arrows-left-right-to-line'],
            ['Broken / uneven surface', 'fa-road-barrier'],
            ['Steps or steep slope with no ramp', 'fa-stairs'],
            ['Open drains / slippery or flooded surface', 'fa-water'],
            ['Poor lighting at night', 'fa-lightbulb'],
            ['Garbage / unclean path', 'fa-trash'],
            ['No shade / shelter', 'fa-sun'],
            ['Crowding', 'fa-people-group'],
            ['Unsafe to cross the road at the path ends', 'fa-car-burst'],
            [SAFETY_DIFFICULTY, 'fa-shield-halved'],
            ['None', 'fa-circle-check']
        ]
    },
    {
        id: 'safetyConcern', label: 'What personal safety concern would you like to mention?', type: 'multi', other: true, optional: true,
        exclusive: 'Prefer not to specify', showIf: a => has(a, 'pathDifficulties', SAFETY_DIFFICULTY), hint: 'Optional · select all that apply',
        options: [['Harassment', 'fa-hand'], ['Fear of theft', 'fa-mask'], ['Isolated places', 'fa-street-view'], ['Poorly lit places', 'fa-moon'], ['Prefer not to specify', 'fa-eye-slash']]
    },
    {
        id: 'mainDifficulty', label: 'Which of these difficulties affects you the most?', type: 'single', optionsFrom: 'pathDifficulties', exclude: ['None'],
        showIf: a => answeredNot(a, 'pathDifficulties', 'None'), main: true
    },
    {
        id: 'improvements', label: 'Which improvements would you like on this walking path?', type: 'multi', other: true, grid: true, exclusive: 'None',
        hint: 'Select all that apply', notes: 'Details in the respondent’s words (optional)',
        options: [
            ['Keep parked vehicles off the walking path', 'fa-ban'],
            ['Wider / continuous walking path', 'fa-arrows-left-right'],
            ['Repair the path surface', 'fa-trowel-bricks'],
            ['Organise space for vending and keep a clear walking path', 'fa-store'],
            ['Cover drains / improve drainage', 'fa-water'],
            ['Better street lighting', 'fa-lightbulb'],
            ['Shade / covered walkway', 'fa-umbrella'],
            ['Ramps / accessible design', 'fa-wheelchair'],
            ['Keep the path clean', 'fa-broom'],
            ['Slower traffic / traffic calming', 'fa-gauge-simple'],
            ['Seating / rest areas', 'fa-chair'],
            ['Signs / wayfinding', 'fa-signs-post'],
            ['Pedestrian-only path', 'fa-person-walking-arrow-right'],
            ['None', 'fa-circle-check']
        ]
    },
    {
        id: 'firstPriority', label: 'Which one improvement would you do first?', type: 'single',
        optionsFrom: 'improvements', exclude: ['None'], emptyOption: 'Not applicable (none selected)'
    }
];

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function readJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}

function writeJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (e) {
        console.error('localStorage write failed for', key, e);
        showStorageWarning();
        return false;
    }
}

function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

const pad2 = n => String(n).padStart(2, '0');
function formatDate(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function formatTime(ts) { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
}
function optionLabel(o) { return Array.isArray(o) ? o[0] : o; }
function optionIcon(o) { return Array.isArray(o) ? o[1] : null; }

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
let session = readJSON(SESSION_KEY, null);
let answers = readJSON(DRAFT_KEY, {});
let isSyncing = false;
let inFlightIds = new Set();
let lastSyncError = null;

const screens = { welcome: $('screen-welcome'), setup: $('screen-setup'), survey: $('screen-survey') };
function showScreen(name) {
    Object.keys(screens).forEach(k => screens[k].classList.toggle('active', k === name));
    document.body.classList.toggle('on-survey', name === 'survey');
}
function saveSession() { writeJSON(SESSION_KEY, session); }
function saveDraft() { writeJSON(DRAFT_KEY, answers); }

// Where to rank places from: the latest GPS fix, else the survey area centre.
function sessionLatLon() {
    if (lastFix) return { lat: lastFix.lat, lon: lastFix.lon };
    const c = CONFIG.surveyAreaCenter;
    return (c && isFinite(c.lat) && isFinite(c.lon)) ? { lat: c.lat, lon: c.lon } : null;
}

// ---------------------------------------------------------------------
// Toasts, modal, storage warning
// ---------------------------------------------------------------------
let toastTimer = null;
function showToast(message, type = 'success') {
    const c = $('toast-container');
    c.innerHTML = '';
    const t = el('div', `toast ${type}`);
    t.textContent = message;
    c.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2200);
}

function openModal({ title, html, okLabel = 'OK', cancelLabel = 'Cancel', danger = false, showCancel = true }) {
    return new Promise(resolve => {
        const modal = $('modal'), ok = $('modal-ok'), cancel = $('modal-cancel');
        $('modal-title').textContent = title;
        $('modal-body').innerHTML = html;
        ok.textContent = okLabel;
        ok.classList.toggle('danger', danger);
        cancel.textContent = cancelLabel;
        cancel.classList.toggle('hidden', !showCancel);
        modal.classList.remove('hidden');
        const close = r => {
            modal.classList.add('hidden');
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            resolve(r);
        };
        const onOk = () => close(true);
        const onCancel = () => close(false);
        ok.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
    });
}

let storageWarningEl = null;
function showStorageWarning() {
    if (storageWarningEl && document.body.contains(storageWarningEl)) return;
    storageWarningEl = el('div', 'storage-warning', 'DEVICE STORAGE FULL: new responses may NOT be saved. Sync or export a backup now. <button type="button">Dismiss</button>');
    storageWarningEl.setAttribute('role', 'alert');
    storageWarningEl.querySelector('button').addEventListener('click', () => { storageWarningEl.remove(); storageWarningEl = null; });
    document.body.prepend(storageWarningEl);
    if (navigator.onLine) syncQueue();
}

// ---------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------
function applyTheme(theme) {
    const isLight = theme === 'light';
    document.body.classList.toggle('light-theme', isLight);
    $('theme-toggle').querySelector('i').className = isLight ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    document.querySelector('meta[name="theme-color"]').setAttribute('content', isLight ? '#f1f5f9' : '#0f172a');
}
$('theme-toggle').addEventListener('click', () => {
    const next = document.body.classList.contains('light-theme') ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme(next);
});

// ---------------------------------------------------------------------
// Welcome + setup
// ---------------------------------------------------------------------
const inputName = $('surveyor-name');
const btnStart = $('btn-start');

$('btn-next').addEventListener('click', () => showScreen('setup'));

function checkSetupForm() {
    const ok = !!inputName.value.trim();
    btnStart.disabled = !ok;
    btnStart.classList.toggle('btn-disabled', !ok);
}
inputName.addEventListener('input', checkSetupForm);

btnStart.addEventListener('click', () => {
    if (btnStart.disabled) return;
    session = { id: generateId(), active: true, name: inputName.value.trim(), startedAt: Date.now() };
    saveSession();
    writeJSON(HISTORY_KEY, []);
    startGps();
    startSurveyScreen();
});

function startSurveyScreen() {
    $('info-name').textContent = session.name;
    renderAllFromAnswers();
    updateCount();
    updateAutoInfo();
    updateGpsStatus();
    updateSyncStatus();
    showScreen('survey');
    setTimeout(() => mapRefreshers.forEach(fn => fn()), 450);
}

// ---------------------------------------------------------------------
// Location: watched while surveying. Each interview saves the position
// taken when it is saved; there is no location to set up.
// ---------------------------------------------------------------------
const GPS_FRESH_MS = 60000;   // a fix this recent is used as it is
const GPS_WAIT_MS = 8000;     // otherwise wait up to this long for a new one
let lastFix = null;           // { lat, lon, acc, ts }
let gpsWatch = null;
let gpsError = '';
const gpsListeners = [];

function onFix(pos) {
    lastFix = {
        lat: +pos.coords.latitude.toFixed(6),
        lon: +pos.coords.longitude.toFixed(6),
        acc: Math.round(pos.coords.accuracy),
        ts: pos.timestamp || Date.now()
    };
    gpsError = '';
    updateGpsStatus();
    gpsListeners.forEach(fn => fn(lastFix));
}
function onFixError(err) {
    gpsError = err && err.code === 1 ? 'denied' : 'unavailable';
    updateGpsStatus();
}
function startGps() {
    if (gpsWatch !== null || !('geolocation' in navigator)) { updateGpsStatus(); return; }
    gpsWatch = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}
function fixIsFresh() { return !!lastFix && Date.now() - lastFix.ts < GPS_FRESH_MS; }

function updateGpsStatus() {
    const chip = $('gps-chip');
    if (!chip) return;
    let cls = 'chip gps-chip', text;
    if (!('geolocation' in navigator)) { cls += ' bad'; text = 'No GPS'; }
    else if (fixIsFresh()) { cls += lastFix.acc <= 30 ? ' good' : ' fair'; text = `GPS \u00b1${lastFix.acc} m`; }
    else if (gpsError === 'denied') { cls += ' bad'; text = 'GPS blocked'; }
    else { cls += ' wait'; text = lastFix ? 'GPS (old fix)' : 'GPS searching\u2026'; }
    chip.className = cls;
    chip.querySelector('.gps-text').textContent = text;
    chip.title = gpsError === 'denied' ? 'Location is blocked: allow location for this site in the browser settings.' : 'Saved with each interview';
    const loc = $('auto-location');
    if (loc) {
        loc.textContent = lastFix ? `${lastFix.lat}, ${lastFix.lon} (\u00b1${lastFix.acc} m)`
            : gpsError === 'denied' ? 'Location blocked' : 'Waiting for GPS\u2026';
    }
}

// The position saved with an interview: the recent fix, else wait briefly for
// a new one, else the last known fix (marked "stale"), else none.
function interviewFix() {
    if (fixIsFresh()) return Promise.resolve(Object.assign({}, lastFix, { status: 'ok' }));
    if (!('geolocation' in navigator)) return Promise.resolve(null);
    return new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolve(lastFix ? Object.assign({}, lastFix, { status: fixIsFresh() ? 'ok' : 'stale' }) : null);
        };
        navigator.geolocation.getCurrentPosition(p => { onFix(p); finish(); }, finish,
            { enableHighAccuracy: true, timeout: GPS_WAIT_MS, maximumAge: GPS_FRESH_MS });
        setTimeout(finish, GPS_WAIT_MS + 500);
    });
}

// Interview ID: enumerator initials, date and a counter on this device,
// e.g. KW-20261019-003.
function initials(name) {
    const letters = String(name || '').trim().split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (letters || 'X').slice(0, 3);
}
function interviewIdKey() { return `${initials(session.name)}-${formatDate(Date.now()).replace(/-/g, '')}`; }
function nextInterviewId(take) {
    const key = interviewIdKey();
    const seq = readJSON(SEQ_KEY, {});
    const n = (seq[key] || 0) + 1;
    if (take) { seq[key] = n; writeJSON(SEQ_KEY, seq); }
    return `${key}-${String(n).padStart(3, '0')}`;
}
function releaseInterviewId(id) {
    // Undoing the most recent interview frees its number again.
    const m = /^(.*)-(\d+)$/.exec(id || '');
    if (!m) return;
    const seq = readJSON(SEQ_KEY, {});
    if (seq[m[1]] === +m[2]) { seq[m[1]] = +m[2] - 1; writeJSON(SEQ_KEY, seq); }
}

// ---------------------------------------------------------------------
// Automatic fields: date, time
// ---------------------------------------------------------------------
function updateAutoInfo() {
    const now = Date.now();
    $('auto-date').textContent = formatDate(now);
    $('auto-time').textContent = formatTime(now).slice(0, 5);
    if (session) $('auto-id').textContent = nextInterviewId(false);
}

// ---------------------------------------------------------------------
// Build the form from FORM
// ---------------------------------------------------------------------
const formEl = $('interview-form');
const renderers = {}; // id -> function that refreshes that question from `answers`

function buildForm() {
    formEl.innerHTML = '';
    let num = 0, sub = 0;
    FORM.forEach(f => {
        if (f.section) formEl.appendChild(el('h2', 'form-section', escapeHtml(f.section)));
        const q = el('section', 'q');
        q.dataset.q = f.id;
        // Sub-questions follow their main question: 5a, 5b, ...
        const qNum = (f.sub || (f.showIf && !f.main)) ? num + 'abcdefgh'[sub++] : (sub = 0, String(++num));
        const label = el('div', 'q-label',
            `<span class="q-num">${qNum}</span><span>${escapeHtml(f.label)}</span>` +
            (f.hint ? `<span class="q-hint">${escapeHtml(f.hint)}</span>` : ''));
        label.id = `lbl-${f.id}`;
        q.appendChild(label);
        if (f.type === 'place') buildPlaceField(q, f);
        else if (f.type === 'route') buildRouteField(q, f);
        else buildChoiceField(q, f);
        formEl.appendChild(q);
    });
}

function isAnswered(f) {
    const v = answers[f.id];
    if (f.type === 'place' && f.multi) return Array.isArray(v) && v.length > 0;
    if (f.type === 'place') return !!(v && v.text && v.text.trim());
    if (f.type === 'route') return !!(v && Array.isArray(v.points) && v.points.length >= 2);
    if (f.type === 'multi') return Array.isArray(v) && v.length > 0;
    return !!(v && String(v).trim());
}

function isVisible(f) { return !f.showIf || !!f.showIf(answers); }
function visibleQuestions() { return FORM.filter(f => isVisible(f) && !f.optional); }

function refreshProgress() {
    let n = 0;
    FORM.forEach(f => {
        const shown = isVisible(f);
        const ok = shown && isAnswered(f);
        if (ok && !f.optional) n++;
        const q = formEl.querySelector(`[data-q="${f.id}"]`);
        if (q) { q.classList.toggle('answered', ok); q.classList.toggle('hidden', !shown); }
    });
    $('progress').textContent = `${n} of ${visibleQuestions().length} answered`;
    return n;
}

function renderAllFromAnswers() {
    Object.values(renderers).forEach(r => r());
    refreshProgress();
}

function changed() {
    // Questions whose options come from another answer follow it.
    FORM.forEach(f => { if (f.optionsFrom && renderers[f.id]) renderers[f.id](); });
    saveDraft();
    refreshProgress();
}

// ----- Choice fields -----
// The options a question offers now: its own list, or for optionsFrom the
// answers ticked in that other question ({ value, label, icon }).
function choiceOptions(f) {
    if (!f.optionsFrom) {
        const opts = f.options.slice();
        if (f.other) opts.push(['Other', 'fa-ellipsis']);
        return opts.map(o => ({ value: optionLabel(o), label: optionLabel(o), icon: optionIcon(o) }));
    }
    const src = FORM.find(x => x.id === f.optionsFrom);
    const icons = {};
    (src.options || []).forEach(o => { icons[optionLabel(o)] = optionIcon(o); });
    const picked = (Array.isArray(answers[src.id]) ? answers[src.id] : []).filter(v => !(f.exclude || []).includes(v));
    const out = picked.map(v => ({
        value: v,
        label: v === 'Other' ? `Other: ${(answers[src.id + 'Other'] || '').trim() || '(not specified)'}` : v,
        icon: v === 'Other' ? 'fa-ellipsis' : icons[v]
    }));
    if (!out.length && f.emptyOption) out.push({ value: f.emptyOption, label: f.emptyOption, icon: 'fa-minus' });
    return out;
}

function buildChoiceField(q, f) {
    const box = el('div', 'chips' + (f.type === 'multi' ? ' multi' : '') + (f.grid ? ' grid' : '') + (f.yesno ? ' yesno' : ''));
    box.setAttribute('role', f.type === 'multi' ? 'group' : 'radiogroup');
    box.setAttribute('aria-labelledby', `lbl-${f.id}`);
    const exclusives = f.exclusive ? [].concat(f.exclusive) : [];
    const emptyNote = f.optionsFrom ? el('p', 'chips-empty hidden', 'Answer the question above first.') : null;

    let otherInput = null;
    let builtFor = null;
    const buildButtons = () => {
        const opts = choiceOptions(f);
        const sig = JSON.stringify(opts.map(o => o.value + '|' + o.label));
        if (sig === builtFor) return;
        builtFor = sig;
        box.innerHTML = '';
        opts.forEach(o => {
            const icon = o.icon;
            const iconHtml = !icon ? '' : icon.startsWith('<') ? icon : `<i class="fa-solid ${icon}"></i>`;
            const b = el('button', 'chip-opt', iconHtml + `<span>${escapeHtml(o.label)}</span>`);
            b.type = 'button';
            b.dataset.value = o.value;
            b.setAttribute('role', f.type === 'multi' ? 'checkbox' : 'radio');
            b.addEventListener('click', () => {
                const value = o.value;
                if (f.type === 'multi') {
                    let arr = Array.isArray(answers[f.id]) ? answers[f.id].slice() : [];
                    if (arr.includes(value)) arr = arr.filter(x => x !== value);
                    else if (exclusives.includes(value)) arr = [value];
                    else {
                        arr = arr.filter(x => !exclusives.includes(x));
                        if (f.max && arr.length >= f.max) {
                            showToast(`Select up to ${f.max === 2 ? 'two' : f.max === 3 ? 'three' : f.max}`, 'error');
                            return;
                        }
                        arr = arr.concat(value);
                    }
                    answers[f.id] = arr;
                } else {
                    answers[f.id] = answers[f.id] === value ? '' : value; // tap again to clear
                }
                renderers[f.id]();
                changed();
                if (value === 'Other' && otherInput && isSelected(f, 'Other')) setTimeout(() => otherInput.focus(), 50);
            });
            box.appendChild(b);
        });
        if (emptyNote) emptyNote.classList.toggle('hidden', opts.length > 0);
    };
    buildButtons();
    q.appendChild(box);
    if (emptyNote) q.appendChild(emptyNote);

    if (f.other) {
        otherInput = el('input', 'other-input hidden');
        otherInput.type = 'text';
        otherInput.placeholder = 'Please specify';
        otherInput.setAttribute('aria-label', `${f.label}: other, please specify`);
        otherInput.addEventListener('input', () => {
            answers[f.id + 'Other'] = otherInput.value;
            saveDraft();
            FORM.forEach(x => { if (x.optionsFrom === f.id && renderers[x.id]) renderers[x.id](); });
        });
        q.appendChild(otherInput);
    }
    let notes = null;
    if (f.notes) {
        notes = el('textarea', 'notes-input');
        notes.rows = 2;
        notes.placeholder = f.notes;
        notes.setAttribute('aria-label', `${f.label}: ${f.notes}`);
        notes.addEventListener('input', () => { answers[f.id + 'Notes'] = notes.value; saveDraft(); });
        q.appendChild(notes);
    }

    renderers[f.id] = () => {
        if (f.optionsFrom) {
            buildButtons();
            // An answer that is no longer offered is cleared.
            if (answers[f.id] && !choiceOptions(f).some(o => o.value === answers[f.id])) { answers[f.id] = ''; saveDraft(); }
        }
        box.querySelectorAll('.chip-opt').forEach(b => {
            const on = isSelected(f, b.dataset.value);
            b.classList.toggle('selected', on);
            b.setAttribute('aria-checked', String(on));
        });
        if (otherInput) {
            otherInput.classList.toggle('hidden', !isSelected(f, 'Other'));
            if (document.activeElement !== otherInput) otherInput.value = answers[f.id + 'Other'] || '';
        }
        if (notes) notes.value = answers[f.id + 'Notes'] || '';
    };
}

function isSelected(f, value) {
    const v = answers[f.id];
    return f.type === 'multi' ? (Array.isArray(v) && v.includes(value)) : v === value;
}

// ----- Place fields (type-ahead suggestions) -----
function recentKey(f) { return f.recentGroup || f.id; }
function recentFor(f, text) {
    if (!f.recent) return [];
    const t = text.toLowerCase();
    return (readJSON(RECENT_KEY, {})[recentKey(f)] || [])
        .filter(r => !t || r.label.toLowerCase().includes(t))
        .slice(0, 4)
        .map(r => Object.assign({}, r, { main: r.label, sub: 'Used before on this phone', recent: true }));
}
function rememberRecent(f, v) {
    if (!f.recent || !v || !v.text || !v.text.trim()) return;
    const all = readJSON(RECENT_KEY, {});
    const key = recentKey(f);
    const label = v.text.trim();
    all[key] = [{ label, lat: v.lat ?? null, lon: v.lon ?? null, source: v.source || 'typed' }]
        .concat((all[key] || []).filter(r => r.label.toLowerCase() !== label.toLowerCase()))
        .slice(0, 15);
    writeJSON(RECENT_KEY, all);
}

// A list from config.js (study-area locations, or e.g. bus routes): all of it
// for an empty box, else the entries containing every typed word.
function presetFor(f, text) {
    if (!f.presets) return [];
    const words = text.toLowerCase().split(/[\s\-–]+/).filter(Boolean);
    const list = (f.presets === true ? CONFIG.presetLocations : CONFIG[f.presets]) || [];
    const sub = f.presetSub || 'Study-area location';
    return list
        .filter(name => words.every(w => name.toLowerCase().includes(w)))
        .map(name => ({ main: name, sub, label: name, lat: null, lon: null, source: 'list', preset: true }));
}

function buildPlaceField(q, f) {
    const wrap = el('div', 'place');
    wrap.innerHTML = `<i class="fa-solid ${f.icon || (f.recent ? 'fa-route' : 'fa-location-dot')} place-icon"></i>`;
    const input = el('input');
    input.type = 'text';
    input.placeholder = f.placeholder || '';
    input.setAttribute('aria-labelledby', `lbl-${f.id}`);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    const clear = el('button', 'place-clear hidden', '<i class="fa-solid fa-xmark"></i>');
    clear.type = 'button';
    clear.setAttribute('aria-label', `Clear ${f.label}`);
    const list = el('ul', 'suggest hidden');
    list.id = `suggest-${f.id}`;
    list.setAttribute('role', 'listbox');
    input.setAttribute('aria-controls', list.id);
    wrap.append(input, clear, list);
    const status = el('div', 'place-status');
    q.append(wrap, status);
    // multi: chosen places become removable chips; the box is for adding the next one.
    const chipsBox = f.multi ? el('div', 'place-chips') : null;
    if (chipsBox) q.appendChild(chipsBox);

    let timer = null, controller = null, items = [], active = -1;

    const renderChips = () => {
        if (!chipsBox) return;
        const arr = Array.isArray(answers[f.id]) ? answers[f.id] : [];
        chipsBox.innerHTML = '';
        arr.forEach((x, k) => {
            const chip = el('span', 'place-chip', `<span>${k + 1}. ${escapeHtml(x.text)}</span>`);
            const rm = el('button', '', '<i class="fa-solid fa-xmark"></i>');
            rm.type = 'button';
            rm.setAttribute('aria-label', `Remove ${x.text}`);
            rm.addEventListener('click', () => {
                answers[f.id] = arr.filter((_, n) => n !== k);
                renderChips();
                changed();
                setStatus();
            });
            chip.appendChild(rm);
            chipsBox.appendChild(chip);
        });
    };

    const hide = () => { list.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); active = -1; };
    const setStatus = () => {
        const v = answers[f.id];
        if (f.multi) {
            const n = Array.isArray(v) ? v.length : 0;
            status.textContent = n ? `✓ ${n} added · type to add another` : '';
            status.className = 'place-status' + (n ? ' ok' : '');
            return;
        }
        if (v && (v.source === 'list' || v.source === 'route') && v.confirmed) { status.textContent = `✓ ${f.presetSub || 'Study-area location'}`; status.className = 'place-status ok'; }
        else if (v && v.lat != null) { status.textContent = '✓ Place selected from map suggestions'; status.className = 'place-status ok'; }
        else if (v && v.text && v.confirmed) { status.textContent = '✓ Saved as typed'; status.className = 'place-status ok'; }
        else if (v && v.text) { status.textContent = 'Typed text will be saved as written'; status.className = 'place-status'; }
        else { status.textContent = ''; status.className = 'place-status'; }
    };

    // The surveyor's own text is always the first choice.
    const typedItem = () => {
        const t = input.value.trim();
        return t ? [{ main: t, sub: 'Use as typed', label: t, lat: null, lon: null, source: 'typed', typed: true }] : [];
    };

    const showItems = (rows, info) => {
        const typed = typedItem();
        const seen = new Set(typed.map(r => r.label.toLowerCase()));
        const rest = rows.filter(r => { const k = r.label.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
        items = typed.concat(rest);
        active = -1;
        list.innerHTML = '';
        items.forEach((r, i) => {
            const li = el('li', r.typed ? 's-typed' : '',
                `<div class="s-main">${r.typed ? '<i class="fa-solid fa-keyboard"></i> ' : r.preset ? '<i class="fa-solid fa-map-pin"></i> ' : ''}${escapeHtml(r.main)}${r.recent ? '<span class="s-tag">recent</span>' : ''}</div>` +
                (r.sub ? `<div class="s-sub">${escapeHtml(r.sub)}</div>` : ''));
            li.setAttribute('role', 'option');
            li.id = `${list.id}-${i}`;
            // Keep focus in the input and choose on a completed tap/click.
            li.addEventListener('mousedown', e => e.preventDefault());
            li.addEventListener('click', () => choose(i));
            list.appendChild(li);
        });
        if (info) list.appendChild(el('li', 's-info', escapeHtml(info)));
        if (rest.some(r => !r.recent && !r.preset) && !info) {
            list.appendChild(el('li', 's-attrib', CONFIG.googlePlacesApiKey ? 'Powered by Google' : 'Suggestions © OpenStreetMap contributors'));
        }
        const open = items.length > 0 || !!info;
        list.classList.toggle('hidden', !open);
        input.setAttribute('aria-expanded', String(open));
    };

    const choose = async i => {
        const r = items[i];
        if (!r) return;
        // Cancel any search still pending from typing, so the list can't reopen.
        clearTimeout(timer);
        if (controller) controller.abort();
        if (f.multi) {
            const arr = Array.isArray(answers[f.id]) ? answers[f.id].slice() : [];
            if (!arr.some(x => x.text.toLowerCase() === r.label.toLowerCase())) {
                arr.push({ text: r.label, lat: r.lat ?? null, lon: r.lon ?? null, source: r.source });
            }
            answers[f.id] = arr;
            input.value = '';
            hide();
            clear.classList.add('hidden');
            renderChips();
            changed();
            setStatus();
            return;
        }
        input.value = r.label;
        answers[f.id] = { text: r.label, lat: r.lat ?? null, lon: r.lon ?? null, source: r.source, placeId: r.placeId || '', confirmed: true };
        hide();
        clear.classList.remove('hidden');
        changed();
        setStatus();
        if (r.source === 'google' && r.placeId && r.lat == null) {
            const loc = await googlePlaceLocation(r.placeId).catch(() => null);
            if (loc && answers[f.id] && answers[f.id].placeId === r.placeId) {
                answers[f.id].lat = loc.lat;
                answers[f.id].lon = loc.lon;
                saveDraft();
                setStatus();
            }
        }
    };

    const highlight = i => {
        const lis = list.querySelectorAll('li[role="option"]');
        lis.forEach((li, k) => li.classList.toggle('active', k === i));
        active = i;
        if (lis[i]) { input.setAttribute('aria-activedescendant', lis[i].id); lis[i].scrollIntoView({ block: 'nearest' }); }
    };

    const search = async text => {
        const qText = text.trim();
        const recent = recentFor(f, qText).concat(presetFor(f, qText));
        if (!qText) { recent.length ? showItems(recent) : hide(); return; }
        if (qText.length < 2 || (f.mapSearch === false && !f.cityRoutes)) { showItems(recent); return; }
        if (!navigator.onLine) { showItems(recent, 'Offline: no map suggestions.'); return; }
        if (controller) controller.abort();
        controller = new AbortController();
        showItems(recent, 'Searching…');
        try {
            let found;
            if (f.cityRoutes) {
                found = (await citySuggestions(qText, controller.signal)).map(c => cityRoute(f, c)).filter(Boolean);
            } else {
                // Cities and towns first (free search only; Google ranks them itself).
                const [cities, places] = await Promise.all([
                    f.cities && !CONFIG.googlePlacesApiKey ? citySuggestions(qText, controller.signal).catch(e => { if (e.name === 'AbortError') throw e; return []; }) : [],
                    placeSuggestions(qText, !!f.nearby, controller.signal)
                ]);
                const cityNames = new Set(cities.map(c => c.main.toLowerCase()));
                found = cities.concat(places.filter(p => !(p.city && cityNames.has(p.main.toLowerCase()))));
            }
            showItems(recent.concat(found), found.length || recent.length ? null : 'No map matches.');
        } catch (e) {
            if (e.name === 'AbortError') return;
            showItems(recent, 'Map suggestions unavailable right now.');
        }
    };

    input.addEventListener('input', () => {
        if (!f.multi) {
            answers[f.id] = { text: input.value, lat: null, lon: null, source: 'typed', placeId: '' };
            changed();
            setStatus();
        }
        clear.classList.toggle('hidden', !input.value);
        clearTimeout(timer);
        // Refresh straight away so no stale suggestion from the previous text can be picked.
        const t = input.value.trim();
        if (t) showItems(recentFor(f, t).concat(presetFor(f, t)), t.length >= 2 && (f.mapSearch !== false || f.cityRoutes) ? 'Searching…' : null); else search('');
        timer = setTimeout(() => search(input.value), 350);
    });
    input.addEventListener('focus', () => {
        // Bring the question to the top so the list has room above the keyboard.
        setTimeout(() => q.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
        const v = answers[f.id];
        if (f.multi || !(v && (v.lat != null || v.confirmed))) search(input.value);
    });
    input.addEventListener('blur', () => setTimeout(hide, 120));
    input.addEventListener('keydown', e => {
        const n = list.querySelectorAll('li[role="option"]').length;
        if (e.key === 'ArrowDown' && n) { e.preventDefault(); highlight((active + 1) % n); }
        else if (e.key === 'ArrowUp' && n) { e.preventDefault(); highlight((active - 1 + n) % n); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (active >= 0 && items[active]) choose(active);
            else if (input.value.trim()) { items = typedItem(); choose(0); } // always the text in the box now
            else hide();
        }
        else if (e.key === 'Escape') hide();
    });
    clear.addEventListener('click', () => {
        input.value = '';
        if (!f.multi) answers[f.id] = null;
        clear.classList.add('hidden');
        hide();
        changed();
        setStatus();
        input.focus();
    });

    renderers[f.id] = () => {
        const v = answers[f.id];
        input.value = f.multi ? '' : ((v && v.text) || '');
        clear.classList.toggle('hidden', !input.value);
        renderChips();
        setStatus();
    };
}

// ----- Route drawn on a map (Leaflet + OpenStreetMap) -----
// The surveyor taps the start, each turn and the end. Each pair of taps is
// joined by the walking route along the streets (OSM foot routing); if that
// service can't be reached the pair is joined by a straight line instead.
const ROUTE_SERVICE = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const MAP_LAYER_KEY = 'kmtt_map_layer';
const mapRefreshers = [];
// A street route is used only if it is at most this much longer than the
// straight line between two taps (else the straight line is kept).
const MAX_DETOUR_RATIO = 2.5;
const MAX_DETOUR_EXTRA_M = 250;

function samePoint(a, b) { return a && b && a[0] === b[0] && a[1] === b[1]; }

function haversineM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function routePath(r) {
    const out = [];
    (r && r.segments || []).forEach(seg => seg.forEach(p => { if (!samePoint(out[out.length - 1], p)) out.push(p); }));
    return out;
}

function routeLength(r) {
    const path = routePath(r);
    let m = 0;
    for (let i = 1; i < path.length; i++) m += haversineM(path[i - 1], path[i]);
    return m;
}

// Google's encoded-polyline format (precision 5): compact, and readable by
// most GIS tools and online decoders.
function encodePolyline(points) {
    let out = '', pLat = 0, pLon = 0;
    const enc = v => {
        v = v < 0 ? ~(v << 1) : (v << 1);
        let s = '';
        while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
        return s + String.fromCharCode(v + 63);
    };
    points.forEach(([lat, lon]) => {
        const iLat = Math.round(lat * 1e5), iLon = Math.round(lon * 1e5);
        out += enc(iLat - pLat) + enc(iLon - pLon);
        pLat = iLat; pLon = iLon;
    });
    return out;
}

// A Google Maps walking-directions link through the tapped points (it allows
// at most 8 stops between start and end, so longer routes are thinned evenly).
function routeMapLink(points) {
    const fmt = p => `${p[0]},${p[1]}`;
    let mid = points.slice(1, -1);
    if (mid.length > 8) mid = Array.from({ length: 8 }, (_, k) => mid[Math.round(k * (mid.length - 1) / 7)]);
    let url = `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${fmt(points[0])}&destination=${fmt(points[points.length - 1])}`;
    if (mid.length) url += `&waypoints=${encodeURIComponent(mid.map(fmt).join('|'))}`;
    return url;
}

// Each point is either on the part already walked ('W') or the part still
// planned ('P'); a segment belongs to the phase of the point it ends at.
function pointPhase(r, k) { return (r.phase && r.phase[k]) || 'W'; }
function segmentLength(seg) {
    let m = 0;
    for (let i = 1; i < seg.length; i++) m += haversineM(seg[i - 1], seg[i]);
    return m;
}
function phaseLengths(r) {
    const out = { W: 0, P: 0 };
    (r && r.segments || []).forEach((seg, i) => { out[pointPhase(r, i + 1)] += segmentLength(seg); });
    return out;
}
function fmtLength(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'; }

function routeRecord(r) {
    if (!r || !Array.isArray(r.points) || r.points.length < 2) {
        return { routeLengthM: '', routeWalkedM: '', routePlannedM: '', routeMapLink: '', routePoints: '', routePath: '' };
    }
    const lens = phaseLengths(r);
    return {
        routeLengthM: Math.round(routeLength(r)),
        routeWalkedM: Math.round(lens.W),
        routePlannedM: Math.round(lens.P),
        routeMapLink: routeMapLink(r.points),
        routePoints: r.points.map((p, k) => `${p[0]},${p[1]},${pointPhase(r, k)}`).join('; '),
        routePath: encodePolyline(routePath(r))
    };
}

function buildRouteField(q, f) {
    const box = el('div', 'route-box');
    const mapEl = el('div', 'route-map');
    const tools = el('div', 'route-tools');
    const mkBtn = (icon, text) => {
        const b = el('button', 'mini-btn', `<i class="fa-solid ${icon}"></i> <span>${text}</span>`);
        b.type = 'button';
        return b;
    };
    const btnUndo = mkBtn('fa-rotate-left', 'Undo point');
    const btnClear = mkBtn('fa-trash-can', 'Clear');
    const btnFull = mkBtn('fa-expand', 'Full screen');
    // Full screen shows only: Minimize, the points line, Undo point and Save route.
    const btnSave = mkBtn('fa-check', 'Save route');
    btnSave.classList.add('route-save');
    // Walked so far / Planned: which part of the trip the next taps mark.
    const btnPhase = mkBtn('fa-person-walking', 'Walked so far');
    btnPhase.classList.add('route-phase');
    tools.append(btnUndo, btnClear, btnFull, btnSave, btnPhase);
    const btnMin = el('button', 'route-min', '<i class="fa-solid fa-compress"></i>');
    btnMin.type = 'button';
    btnMin.title = 'Minimize';
    btnMin.setAttribute('aria-label', 'Minimize map');
    const info = el('div', 'route-info');
    // Full screen only: a search box that moves the map to a place.
    const sWrap = el('div', 'place route-search', '<i class="fa-solid fa-magnifying-glass place-icon"></i>');
    const sInput = el('input');
    sInput.type = 'text';
    sInput.placeholder = 'Search a place, road or shop';
    sInput.autocomplete = 'off';
    sInput.setAttribute('enterkeyhint', 'search');
    sInput.setAttribute('aria-label', 'Search the map');
    const sList = el('ul', 'suggest hidden');
    sList.id = `suggest-${f.id}-search`;
    sList.setAttribute('role', 'listbox');
    sWrap.append(sInput, sList);
    box.append(mapEl, btnMin, sWrap, tools, info);
    q.appendChild(box);

    let map = null, layer = null, pending = 0, areaBounds = null, pin = null, hereLayer = null;

    const current = () => {
        const r = answers[f.id];
        return (r && Array.isArray(r.points)) ? r : { points: [], segments: [], routed: [], phase: [] };
    };
    const mode = () => answers[f.id + 'Mode'] || 'W';
    const showMode = () => {
        const planned = mode() === 'P';
        btnPhase.classList.toggle('planned', planned);
        btnPhase.innerHTML = planned ? '<i class="fa-solid fa-forward"></i> <span>Planned (still to walk)</span>'
            : '<i class="fa-solid fa-person-walking"></i> <span>Walked so far</span>';
        btnPhase.title = 'Tap to switch what the next points mark';
    };

    const updateInfo = () => {
        const r = current();
        const n = r.points.length;
        btnUndo.disabled = n === 0;
        btnClear.disabled = n === 0;
        if (!map && typeof L === 'undefined') {
            info.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> The map needs internet. Add the landmarks below instead.';
            info.className = 'route-info warn';
            return;
        }
        if (n === 0) { info.textContent = 'Tap the map where the walk started.'; info.className = 'route-info'; return; }
        if (n === 1) { info.textContent = 'Now tap each turn, then where the walk ends.'; info.className = 'route-info'; return; }
        const lens = phaseLengths(r);
        const straight = r.routed.some(x => !x);
        info.innerHTML = `\u2713 ${n} points \u00b7 walked ${fmtLength(lens.W)}` + (lens.P ? ` \u00b7 planned ${fmtLength(lens.P)}` : '') +
            (pending ? ' \u00b7 following streets\u2026' : straight && !pending ? ' \u00b7 some parts straight (add a point at each turn)' : '');
        info.className = 'route-info ok';
    };

    const draw = () => {
        if (map) {
            layer.clearLayers();
            const r = current();
            // Walked: solid blue. Planned (still to walk): dashed orange.
            r.segments.forEach((seg, i) => {
                const planned = pointPhase(r, i + 1) === 'P';
                L.polyline(seg, planned ? { color: '#f97316', weight: 5, opacity: 0.9, dashArray: '8 8' }
                    : { color: '#2563eb', weight: 5, opacity: 0.85 }).addTo(layer);
            });
            r.points.forEach((p, k) => {
                const cls = (k === 0 ? 'start' : (k === r.points.length - 1 && k > 0 ? 'end' : '')) + (pointPhase(r, k) === 'P' ? ' planned' : '');
                L.marker(p, {
                    icon: L.divIcon({ className: 'route-pt ' + cls, html: `<span>${k + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
                    keyboard: false
                }).addTo(layer);
            });
        }
        updateInfo();
    };

    const fetchSegment = (i, a, b) => {
        if (!navigator.onLine) return;
        pending++;
        fetch(`${ROUTE_SERVICE}${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`)
            .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
            .then(d => {
                const r = answers[f.id];
                // Ignore the answer if the route changed meanwhile (undo, clear, saved).
                if (!r || !samePoint(r.points[i], a) || !samePoint(r.points[i + 1], b)) return;
                const coords = d && d.routes && d.routes[0] && d.routes[0].geometry && d.routes[0].geometry.coordinates;
                if (!coords || coords.length < 2) return;
                // A street route far longer than the straight line usually means a
                // tap snapped to a path that is not connected (or across a river,
                // railway, private land): keep the straight line instead.
                const direct = haversineM(a, b);
                const via = d.routes[0].distance || 0;
                if (via > Math.max(direct * MAX_DETOUR_RATIO, direct + MAX_DETOUR_EXTRA_M)) {
                    r.detour = r.detour || [];
                    r.detour[i] = true;
                    saveDraft();
                    return;
                }
                r.segments[i] = [a].concat(coords.map(c => [+c[1].toFixed(6), +c[0].toFixed(6)])).concat([b]);
                r.routed[i] = true;
                saveDraft();
            })
            .catch(() => {})
            .finally(() => { pending--; draw(); });
    };

    const addPoint = latlng => {
        const r = current();
        const p = [+latlng.lat.toFixed(6), +latlng.lng.toFixed(6)];
        r.points.push(p);
        r.phase = (r.phase || []).slice(0, r.points.length - 1);
        while (r.phase.length < r.points.length - 1) r.phase.push('W');
        r.phase.push(mode());
        if (r.points.length >= 2) {
            const a = r.points[r.points.length - 2];
            r.segments.push([a, p]);     // straight until the street route arrives
            r.routed.push(false);
            fetchSegment(r.points.length - 2, a, p);
        }
        answers[f.id] = r;
        changed();
        draw();
    };

    const ensureMap = () => {
        if (map) return true;
        if (typeof L === 'undefined') { updateInfo(); return false; }
        // The survey area (Kandy town) is outlined; the map can be moved and
        // tapped anywhere inside the larger outer area around it.
        const toBounds = bb => Array.isArray(bb) && bb.length === 4 ? L.latLngBounds([bb[1], bb[0]], [bb[3], bb[2]]) : null;
        const area = toBounds(CONFIG.mapBounds);
        const outer = toBounds(CONFIG.mapOuterBounds) || (area ? area.pad(0.05) : null);
        areaBounds = outer;
        const here = sessionLatLon();
        const home = CONFIG.surveyAreaCenter || { lat: 7.2906, lon: 80.6337 };
        // (sessionLatLon is the latest GPS fix, so the map opens at the interview.)
        const c = here && (!outer || outer.contains([here.lat, here.lon])) ? here : home;
        map = L.map(mapEl, {
            zoomControl: true, attributionControl: true, minZoom: CONFIG.mapMinZoom || 7, maxZoom: 20,
            maxBounds: outer, maxBoundsViscosity: 1.0
        }).setView([c.lat, c.lon], 17);
        const tileBounds = outer ? outer.pad(0.2) : undefined;
        const satellite = L.layerGroup([
            L.tileLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                maxNativeZoom: 19, maxZoom: 20, bounds: tileBounds,
                attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics'
            }),
            // Road names on top of the photo.
            L.tileLayer(ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
                maxNativeZoom: 19, maxZoom: 20, bounds: tileBounds, opacity: 0.9
            })
        ]);
        const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxNativeZoom: 19, maxZoom: 20, bounds: tileBounds,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        });
        let saved = null;
        try { saved = localStorage.getItem(MAP_LAYER_KEY); } catch (e) {}
        const first = (saved || CONFIG.mapDefaultLayer || 'satellite') === 'street' ? street : satellite;
        first.addTo(map);
        L.control.layers({ 'Satellite': satellite, 'Street map': street }, null, { collapsed: false, position: 'topright' }).addTo(map);
        map.on('baselayerchange', e => {
            try { localStorage.setItem(MAP_LAYER_KEY, e.layer === street ? 'street' : 'satellite'); } catch (err) {}
        });
        if (area) L.rectangle(area, { color: '#facc15', weight: 2, dashArray: '6 6', fill: false, interactive: false }).addTo(map);
        layer = L.layerGroup().addTo(map);
        // "You are here": the interview position (it splits walked from planned).
        hereLayer = L.layerGroup().addTo(map);
        const showHere = fix => {
            hereLayer.clearLayers();
            if (!fix) return;
            L.circle([fix.lat, fix.lon], { radius: Math.min(fix.acc || 0, 150), color: '#0ea5e9', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(hereLayer);
            L.circleMarker([fix.lat, fix.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#0ea5e9', fillOpacity: 1, interactive: false })
                .bindTooltip('Interview location', { direction: 'top', offset: [0, -6] }).addTo(hereLayer);
        };
        showHere(lastFix);
        gpsListeners.push(showHere);
        // A double tap must not zoom, nor add the same point twice.
        map.doubleClickZoom.disable();
        let lastTap = null;
        map.on('click', e => {
            const now = Date.now(), pt = e.containerPoint;
            if (lastTap && now - lastTap.t < 400 && pt.distanceTo(lastTap.pt) < 20) return;
            lastTap = { t: now, pt };
            if (outer && !outer.contains(e.latlng)) { showToast('Outside the map area', 'error'); return; }
            addPoint(e.latlng);
        });
        draw();
        fitToRoute();
        return true;
    };

    const fitToRoute = () => {
        const r = current();
        if (map && r.points.length >= 2) map.fitBounds(L.latLngBounds(routePath(r)), { padding: [30, 30], maxZoom: 17 });
    };

    // Create the map when the question first comes into view (it needs a real size).
    if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting) && ensureMap()) { map.invalidateSize(); }
        });
        io.observe(mapEl);
    } else {
        setTimeout(ensureMap, 600);
    }
    mapRefreshers.push(() => { if (map) map.invalidateSize(); });

    btnUndo.addEventListener('click', () => {
        const r = current();
        if (!r.points.length) return;
        r.points.pop();
        if (r.phase) r.phase.length = r.points.length;
        if (r.segments.length >= r.points.length && r.segments.length) {
            r.segments.pop();
            r.routed.pop();
            if (r.detour) r.detour.length = r.segments.length;
        }
        answers[f.id] = r.points.length ? r : null;
        changed();
        draw();
    });
    btnClear.addEventListener('click', async () => {
        if (!current().points.length) return;
        const ok = await openModal({ title: 'Clear the route?', html: 'All points on the map will be removed.', okLabel: 'Clear', danger: true });
        if (!ok) return;
        answers[f.id] = null;
        changed();
        draw();
    });
    // ----- map search (full screen) -----
    let sTimer = null, sCtrl = null, sItems = [];
    const sHide = () => sList.classList.add('hidden');
    const sShow = (rows, note) => {
        sItems = rows;
        sList.innerHTML = '';
        rows.forEach(r => {
            const li = el('li', '', `<div class="s-main">${escapeHtml(r.main)}</div>` + (r.sub ? `<div class="s-sub">${escapeHtml(r.sub)}</div>` : ''));
            li.setAttribute('role', 'option');
            li.addEventListener('mousedown', e => e.preventDefault());
            li.addEventListener('click', () => goTo(r));
            sList.appendChild(li);
        });
        if (note) sList.appendChild(el('li', 's-info', escapeHtml(note)));
        else if (rows.length) sList.appendChild(el('li', 's-attrib', CONFIG.googlePlacesApiKey ? 'Powered by Google' : 'Suggestions © OpenStreetMap contributors'));
        sList.classList.toggle('hidden', !rows.length && !note);
    };
    const runSearch = async () => {
        const t = sInput.value.trim();
        if (t.length < 2) { sHide(); return; }
        if (!navigator.onLine) { sShow([], 'Offline: search needs internet.'); return; }
        if (sCtrl) sCtrl.abort();
        sCtrl = new AbortController();
        if (!sItems.length) sShow([], 'Searching…');
        try {
            const found = await mapSearchSuggestions(t, sCtrl.signal);
            sShow(found, found.length ? null : 'No places found in the map area.');
        } catch (e) {
            if (e.name !== 'AbortError') sShow([], 'Search unavailable right now.');
        }
    };
    const removePin = () => { if (pin) { pin.remove(); pin = null; } };
    const goTo = async r => {
        clearTimeout(sTimer);
        if (sCtrl) sCtrl.abort();
        sHide();
        let lat = r.lat, lon = r.lon;
        if (lat == null && r.placeId) {
            const loc = await googlePlaceLocation(r.placeId).catch(() => null);
            if (loc) { lat = loc.lat; lon = loc.lon; }
        }
        if (lat == null || !map) { showToast('No map position for this place', 'error'); return; }
        if (areaBounds && !areaBounds.contains([lat, lon])) { showToast('Outside the map area', 'error'); return; }
        sInput.value = r.main;
        sInput.blur();
        map.setView([lat, lon], r.city ? 14 : 18); // a town: show its centre; a place: close up
        removePin();
        // A red pin marks the place; tapping it adds it as a route point.
        pin = L.marker([lat, lon], {
            icon: L.divIcon({ className: 'route-search-pin', html: '<i class="fa-solid fa-location-dot"></i>', iconSize: [32, 32], iconAnchor: [16, 32] }),
            keyboard: false
        }).addTo(map);
        pin.bindTooltip(`${escapeHtml(r.main)}<br><small>Tap the pin to add it as a point</small>`, { permanent: true, direction: 'top', offset: [0, -30], className: 'route-search-tip' });
        pin.on('click', () => { const p = pin.getLatLng(); removePin(); addPoint(p); });
    };
    sInput.addEventListener('input', () => {
        clearTimeout(sTimer);
        if (sInput.value.trim().length < 2) { sItems = []; sHide(); return; }
        sTimer = setTimeout(runSearch, 350);
    });
    sInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(sTimer);
            if (sItems[0]) goTo(sItems[0]); else runSearch();
        } else if (e.key === 'Escape') sHide();
    });
    sInput.addEventListener('focus', () => { if (sItems.length) sShow(sItems); });
    sInput.addEventListener('blur', () => setTimeout(sHide, 150));

    // Full screen moves the map into its own layer on <body>: inside the
    // scrolling form, iPhone Safari clips even a position:fixed element.
    let overlay = null, slot = null;
    const isFull = () => slot !== null;
    const setFull = on => {
        if (on === isFull()) return;
        if (on) {
            if (!overlay) { overlay = el('div', 'route-overlay'); document.body.appendChild(overlay); }
            slot = document.createComment('route-map');
            box.before(slot);
            overlay.appendChild(box);
            overlay.classList.add('open');
        } else {
            slot.replaceWith(box);
            slot = null;
            overlay.classList.remove('open');
            removePin();
            sInput.value = '';
            sItems = [];
            sHide();
        }
        document.body.classList.toggle('route-full-open', on);
        setTimeout(() => { if (map) { map.invalidateSize(); fitToRoute(); } }, 150);
    };
    // The phone's Back button minimizes the map instead of leaving the survey.
    const closeFull = () => {
        if (!isFull()) return;
        if (history.state && history.state.routeFull) history.back();
        else setFull(false);
    };
    window.addEventListener('popstate', () => { if (isFull()) setFull(false); });
    btnFull.addEventListener('click', () => {
        if (isFull()) return;
        try { history.pushState({ routeFull: true }, ''); } catch (e) {}
        setFull(true);
    });
    btnMin.addEventListener('click', closeFull);
    btnSave.addEventListener('click', () => {
        if (current().points.length < 2) { showToast('Tap the start and the end of the walk first', 'error'); return; }
        closeFull();
        showToast('Route saved');
    });
    btnPhase.addEventListener('click', () => {
        answers[f.id + 'Mode'] = mode() === 'P' ? 'W' : 'P';
        saveDraft();
        showMode();
        showToast(mode() === 'P' ? 'Next points: planned part (still to walk)' : 'Next points: part already walked');
    });

    renderers[f.id] = () => { showMode(); draw(); fitToRoute(); };
}

// ---------------------------------------------------------------------
// Place suggestion providers
// ---------------------------------------------------------------------
function placeSuggestions(text, nearby, signal) {
    return CONFIG.googlePlacesApiKey ? googleSuggestions(text, nearby, signal) : photonSuggestions(text, nearby, signal);
}

// Every city and town in Sri Lanka (OpenStreetMap place=city / town).
async function citySuggestions(text, signal) {
    const p = new URLSearchParams({ q: text, limit: '6', lang: 'en' });
    p.append('osm_tag', 'place:city');
    p.append('osm_tag', 'place:town');
    if (Array.isArray(CONFIG.placeSearchBbox) && CONFIG.placeSearchBbox.length === 4) p.set('bbox', CONFIG.placeSearchBbox.join(','));
    const res = await fetch('https://photon.komoot.io/api/?' + p.toString(), { signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return (data.features || []).map(ft => {
        const pr = ft.properties || {};
        const [lon, lat] = (ft.geometry && ft.geometry.coordinates) || [null, null];
        const sub = [pr.osm_value === 'city' ? 'City' : 'Town', pr.county || pr.state].filter(Boolean).join(' · ');
        return { main: pr.name || '', sub, label: pr.name || '', lat, lon, source: 'osm', city: true };
    }).filter(r => r.main);
}

// A town as a bus route to / from the survey town: "Badulla – Kandy".
function cityRoute(f, c) {
    const home = CONFIG.surveyAreaName || 'Kandy';
    if (c.main.toLowerCase() === home.toLowerCase()) return null;
    const label = f.cityRoutes === 'from' ? `${c.main} – ${home}` : `${home} – ${c.main}`;
    return { main: label, sub: `Bus route · ${c.sub}`, label, lat: null, lon: null, source: 'route' };
}

// Full-screen map search: places inside the map's outer area (all of Sri Lanka).
// Every matching Sri Lankan city / town first, then other places (nearest first).
async function mapSearchSuggestions(text, signal) {
    if (CONFIG.googlePlacesApiKey) return googleSuggestions(text, true, signal);
    const [cities, places] = await Promise.all([
        citySuggestions(text, signal).catch(e => { if (e.name === 'AbortError') throw e; return []; }),
        photonSuggestions(text, true, signal, CONFIG.mapOuterBounds || CONFIG.mapBounds, 8)
    ]);
    const cityNames = new Set(cities.map(c => c.main.toLowerCase()));
    return cities.concat(places.filter(p => !(p.city && cityNames.has(p.main.toLowerCase()))));
}

// Free: Photon (komoot) over OpenStreetMap data. No key needed.
async function photonSuggestions(text, nearby, signal, bbox, limit) {
    const p = new URLSearchParams({ q: text, limit: String(limit || 6), lang: 'en' });
    const box = bbox || CONFIG.placeSearchBbox;
    if (Array.isArray(box) && box.length === 4) p.set('bbox', box.join(','));
    const here = sessionLatLon() || (bbox ? CONFIG.surveyAreaCenter : null);
    if (here) {
        p.set('lat', here.lat);
        p.set('lon', here.lon);
        // Bus stands / landmarks: strongly prefer the immediate area; trips: gentle bias.
        p.set('zoom', nearby ? '16' : '10');
        p.set('location_bias_scale', nearby ? '0' : '0.2');
    }
    const res = await fetch('https://photon.komoot.io/api/?' + p.toString(), { signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return (data.features || []).map(ft => {
        const pr = ft.properties || {};
        const main = pr.name || [pr.housenumber, pr.street].filter(Boolean).join(' ') || pr.city || pr.county || '';
        const parts = [];
        [pr.name ? pr.street : null, pr.district, pr.city, pr.county, pr.state].forEach(x => {
            if (x && x !== main && !parts.includes(x)) parts.push(x);
        });
        const sub = parts.join(', ');
        const [lon, lat] = (ft.geometry && ft.geometry.coordinates) || [null, null];
        return { main, sub, label: sub ? `${main}, ${sub}` : main, lat, lon, source: 'osm', city: pr.osm_key === 'place' && (pr.osm_value === 'city' || pr.osm_value === 'town') };
    }).filter(r => r.main);
}

// Optional: Google Places API (New). Used only when a key is set in config.js.
let googleSessionToken = null;
async function googleSuggestions(text, nearby, signal) {
    if (!googleSessionToken) googleSessionToken = generateId();
    const body = { input: text, sessionToken: googleSessionToken, includedRegionCodes: [CONFIG.placeSearchCountry || 'lk'] };
    const here = sessionLatLon();
    if (here) body.locationBias = { circle: { center: { latitude: here.lat, longitude: here.lon }, radius: nearby ? 2000 : 30000 } };
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': CONFIG.googlePlacesApiKey },
        body: JSON.stringify(body),
        signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return (data.suggestions || []).filter(s => s.placePrediction).map(s => {
        const pp = s.placePrediction;
        const main = (pp.structuredFormat && pp.structuredFormat.mainText && pp.structuredFormat.mainText.text) || (pp.text && pp.text.text) || '';
        const sub = (pp.structuredFormat && pp.structuredFormat.secondaryText && pp.structuredFormat.secondaryText.text) || '';
        return { main, sub, label: (pp.text && pp.text.text) || main, lat: null, lon: null, source: 'google', placeId: pp.placeId };
    });
}

async function googlePlaceLocation(placeId) {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(googleSessionToken || '')}`;
    googleSessionToken = null; // a session ends with the details call
    const res = await fetch(url, { headers: { 'X-Goog-Api-Key': CONFIG.googlePlacesApiKey, 'X-Goog-FieldMask': 'location' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    return d.location ? { lat: d.location.latitude, lon: d.location.longitude } : null;
}

// ---------------------------------------------------------------------
// Save / clear / undo
// ---------------------------------------------------------------------
function singleValue(id) {
    const v = answers[id] || '';
    if (v === 'Other') {
        const o = (answers[id + 'Other'] || '').trim();
        return o ? `Other: ${o}` : 'Other';
    }
    return v;
}
function multiValue(id) {
    const arr = Array.isArray(answers[id]) ? answers[id] : [];
    return arr.map(v => {
        if (v !== 'Other') return v;
        const o = (answers[id + 'Other'] || '').trim();
        return o ? `Other: ${o}` : 'Other';
    }).join('; ');
}
function placeParts(id) {
    const v = answers[id] || {};
    return { text: (v.text || '').trim(), lat: v.lat ?? '', lon: v.lon ?? '' };
}
function notesValue(id) { return (answers[id + 'Notes'] || '').trim(); }

// The answer to a question shown on this form, '' when the question is hidden.
function shown(id) { const f = FORM.find(x => x.id === id); return !!f && isVisible(f); }
function fromValue(id) {
    // Options taken from another question: "Other" becomes its typed text.
    const f = FORM.find(x => x.id === id);
    const v = answers[id] || '';
    if (v === 'Other' && f.optionsFrom) {
        const o = (answers[f.optionsFrom + 'Other'] || '').trim();
        return o ? `Other: ${o}` : 'Other';
    }
    return v;
}
function placeCols(id, prefix) {
    const p = shown(id) ? placeParts(id) : { text: '', lat: '', lon: '' };
    return { [prefix]: p.text, [prefix + 'Lat']: p.lat, [prefix + 'Lon']: p.lon };
}

function buildRecord(fix, interviewId, ts) {
    const now = ts || Date.now();
    const g = fix || {};
    const busCols = (prefix, terminalId, routeId) => ({
        [prefix + 'BusTerminal']: shown(terminalId) ? placeParts(terminalId).text : '',
        [prefix + 'BusRoute']: shown(routeId) ? placeParts(routeId).text : ''
    });
    return {
        action: 'submit',
        surveyType: SURVEY_TYPE,
        eventId: generateId(),
        sessionId: session.id,
        interviewId,
        name: session.name,
        date: formatDate(now),
        time: formatTime(now),
        gpsLat: g.lat ?? '',
        gpsLon: g.lon ?? '',
        gpsAccuracyM: g.acc ?? '',
        gpsFixTime: g.ts ? formatTime(g.ts) : '',
        gpsStatus: fix ? fix.status : 'unavailable',
        locationMapLink: fix ? `https://www.google.com/maps?q=${g.lat},${g.lon}` : '',
        // A. About you
        gender: singleValue('gender'),
        age: singleValue('age'),
        vulnerability: multiValue('vulnerability'),
        difficulties: multiValue('difficulties'),
        purpose: singleValue('purpose'),
        category: singleValue('category'),
        accompanying: multiValue('accompanying'),
        // B. This trip
        ...placeCols('origin', 'origin'),
        ...placeCols('destination', 'destination'),
        frequency: singleValue('frequency'),
        startMode: singleValue('startMode'),
        ...busCols('start', 'startBusTerminal', 'startBusRoute'),
        endMode: singleValue('endMode'),
        ...busCols('end', 'endBusTerminal', 'endBusRoute'),
        routeReason: multiValue('routeReason'),
        walkTime: singleValue('walkTime'),
        // C. The walking path
        pathDifficulties: multiValue('pathDifficulties'),
        pathDifficultiesNotes: notesValue('pathDifficulties'),
        safetyConcern: shown('safetyConcern') ? multiValue('safetyConcern') : '',
        mainDifficulty: shown('mainDifficulty') ? fromValue('mainDifficulty') : '',
        improvements: multiValue('improvements'),
        improvementsNotes: notesValue('improvements'),
        firstPriority: fromValue('firstPriority')
    };
}

function resetForm() {
    answers = {};
    saveDraft();
    renderAllFromAnswers();
    updateAutoInfo();
    $('form-scroll').scrollTo({ top: 0, behavior: 'smooth' });
}

let saving = false;
$('btn-save').addEventListener('click', async () => {
    const n = refreshProgress();
    if (n === 0) { showToast('Nothing answered yet', 'error'); return; }
    const total = visibleQuestions().length;
    if (n < total) {
        const missing = visibleQuestions().filter(f => !isAnswered(f)).map(f => `<li>${escapeHtml(f.label)}</li>`).join('');
        const ok = await openModal({
            title: `Save with ${total - n} unanswered?`,
            html: `These questions are blank:<ul style="margin:0.5rem 0 0 1.2rem">${missing}</ul>`,
            okLabel: 'Save anyway',
            cancelLabel: 'Go back'
        });
        if (!ok) return;
    }
    if (saving) return;
    saving = true;
    const btn = $('btn-save');
    btn.disabled = true;
    const savedAt = Date.now();
    if (!fixIsFresh()) showToast('Getting the interview location\u2026', 'info');
    let fix = null;
    try { fix = await interviewFix(); } finally { saving = false; btn.disabled = false; }
    const record = buildRecord(fix, nextInterviewId(true), savedAt);
    const queue = readJSON(QUEUE_KEY, []);
    queue.push(record);
    if (!writeJSON(QUEUE_KEY, queue)) { showToast('STORAGE FULL: response NOT saved!', 'error'); return; }
    const backup = readJSON(BACKUP_KEY, []);
    backup.push(record);
    writeJSON(BACKUP_KEY, backup);
    const history = readJSON(HISTORY_KEY, []);
    history.push(record.eventId);
    writeJSON(HISTORY_KEY, history.slice(-50));
    FORM.forEach(f => {
        if (!f.recent) return;
        const v = answers[f.id];
        (Array.isArray(v) ? v : [v]).forEach(x => rememberRecent(f, x));
    });

    resetForm();
    updateCount();
    updateSyncStatus();
    showToast(fix ? `Interview ${record.interviewId} saved` : `Interview ${record.interviewId} saved (no GPS location)`, fix ? 'success' : 'error');
    syncQueue();
});

$('btn-clear').addEventListener('click', async () => {
    if (refreshProgress() === 0) return;
    const ok = await openModal({ title: 'Clear this form?', html: 'All answers on the form will be removed. Saved interviews are not affected.', okLabel: 'Clear', danger: true });
    if (ok) resetForm();
});

$('btn-undo').addEventListener('click', async () => {
    const history = readJSON(HISTORY_KEY, []);
    const id = history[history.length - 1];
    if (!id) { showToast('Nothing to undo', 'error'); return; }
    if (inFlightIds.has(id)) { showToast('Sending it right now. Try again in a moment.', 'error'); return; }
    const record = readJSON(QUEUE_KEY, []).find(r => r.eventId === id);
    if (!record) {
        history.pop();
        writeJSON(HISTORY_KEY, history);
        showToast('Already synced to the sheet. Cannot undo.', 'error');
        return;
    }
    const ok = await openModal({
        title: 'Delete the last saved interview?',
        html: `${escapeHtml(record.interviewId)}, saved at ${escapeHtml(record.time)}.`,
        okLabel: 'Delete',
        danger: true
    });
    if (!ok) return;
    history.pop();
    writeJSON(HISTORY_KEY, history);
    writeJSON(QUEUE_KEY, readJSON(QUEUE_KEY, []).filter(r => r.eventId !== id));
    writeJSON(BACKUP_KEY, readJSON(BACKUP_KEY, []).filter(r => r.eventId !== id));
    releaseInterviewId(record.interviewId);
    updateCount();
    updateAutoInfo();
    updateSyncStatus();
    showToast('Last interview deleted');
});

function sessionRecords() {
    if (!session) return [];
    return readJSON(BACKUP_KEY, []).filter(r => r.sessionId === session.id);
}
function updateCount() { $('count-session').textContent = sessionRecords().length; }

// ---------------------------------------------------------------------
// End survey
// ---------------------------------------------------------------------
$('btn-end').addEventListener('click', async () => {
    const records = sessionRecords();
    const draftN = refreshProgress();
    const ok = await openModal({
        title: 'End survey?',
        html: `Enumerator <b>${escapeHtml(session.name)}</b>: ${records.length} interview(s) saved.` +
            (draftN ? '<br><b>The form on screen is not saved yet</b> and will be kept as a draft.' : ''),
        okLabel: 'End survey',
        danger: true
    });
    if (!ok) return;
    session.active = false;
    saveSession();
    writeJSON(HISTORY_KEY, []);
    syncQueue();
    const pending = readJSON(QUEUE_KEY, []).length;
    await openModal({
        title: `${session.name}: survey ended`,
        html: `<table>
            <tr><td>Interviews saved</td><td>${records.length}</td></tr>
            <tr><td>Waiting to sync (this device)</td><td>${pending}</td></tr>
        </table>` + (pending ? '<p style="margin-top:0.6rem">Keep the app open with internet until everything is synced, or export a backup.</p>' : ''),
        okLabel: 'New survey',
        showCancel: false
    });
    fillSetupFromSession();
    showScreen('setup');
});

function fillSetupFromSession() {
    inputName.value = session.name || '';
    checkSetupForm();
}

// ---------------------------------------------------------------------
// Sync (batches of 50, removed from the queue only after server success)
// ---------------------------------------------------------------------
function isBackendConfigured() { return !!CONFIG.appsScriptUrl && CONFIG.appsScriptUrl !== PLACEHOLDER_URL; }

function syncQueue() {
    if (isSyncing || !navigator.onLine || !isBackendConfigured()) { updateSyncStatus(); return; }
    const queue = readJSON(QUEUE_KEY, []);
    if (!queue.length) { updateSyncStatus(); return; }
    const batch = queue.slice(0, BATCH_SIZE);
    isSyncing = true;
    inFlightIds = new Set(batch.map(r => r.eventId));
    updateSyncStatus();

    fetch(CONFIG.appsScriptUrl, {
        method: 'POST',
        body: JSON.stringify({ action: SYNC_ACTION, payload: batch }),
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    })
        .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(result => {
            if (result.status !== 'success') throw new Error(result.message || 'Server error');
            writeJSON(QUEUE_KEY, readJSON(QUEUE_KEY, []).filter(r => !inFlightIds.has(r.eventId)));
            lastSyncError = null;
        })
        .catch(err => { lastSyncError = err.message || String(err); console.error('Sync failed:', err); })
        .finally(() => {
            isSyncing = false;
            inFlightIds = new Set();
            updateSyncStatus();
            if (!lastSyncError && readJSON(QUEUE_KEY, []).length) setTimeout(syncQueue, 800);
        });
}

function updateSyncStatus() {
    const node = $('sync-status');
    const pending = readJSON(QUEUE_KEY, []).length;
    let cls = 'sync-status', label;
    if (!isBackendConfigured()) { cls += ' unconfigured'; label = `Not linked to sheet · ${pending} on device`; }
    else if (!navigator.onLine) { cls += ' offline'; label = `Offline · ${pending} pending`; }
    else if (isSyncing) { cls += ' syncing'; label = `Syncing · ${pending} pending`; }
    else if (lastSyncError && pending) { cls += ' error'; label = `Sync error · ${pending} pending`; }
    else if (pending) { cls += ' pending'; label = `Online · ${pending} pending`; }
    else label = 'Online · Synced';
    node.className = cls;
    node.querySelector('.sync-text').textContent = label;
    node.title = lastSyncError ? `Last error: ${lastSyncError}` : '';
}
window.addEventListener('online', () => { updateSyncStatus(); syncQueue(); });
window.addEventListener('offline', updateSyncStatus);

// ---------------------------------------------------------------------
// Local backup export
// ---------------------------------------------------------------------
function exportLocalBackup() {
    const records = readJSON(BACKUP_KEY, []);
    const pending = readJSON(QUEUE_KEY, []);
    if (!records.length && !pending.length) { showToast('No responses on this device yet', 'error'); return; }
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records, pendingSync: pending, draft: answers }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = `kmtt_walkability_backup_${formatDate(Date.now())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Backup exported (${records.length} interviews)`);
}
$('btn-export').addEventListener('click', exportLocalBackup);
$('btn-export-setup').addEventListener('click', exportLocalBackup);

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
function init() {
    let theme = 'dark';
    try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
    applyTheme(theme);

    // Netlify's hosting badge sits in the bottom-right corner; the CSS keeps
    // the Save button out from under it. Netlify inserts its script after
    // app.js, so look again once the whole page has been parsed.
    const markHostBadge = () => {
        if (/\.netlify\.app$/.test(location.hostname) || document.querySelector('script[src*="/.netlify/scripts/"]')) {
            document.body.classList.add('has-host-badge');
        }
    };
    markHostBadge();
    document.addEventListener('DOMContentLoaded', markHostBadge);

    if (CONFIG.surveyAreaName) {
        document.querySelector('#screen-welcome .subtitle').textContent = `${CONFIG.surveyAreaName} · One form per interview`;
    }

    buildForm();
    if (session) fillSetupFromSession();
    if (session && session.active) {
        startGps();
        startSurveyScreen();
        if (refreshProgress()) showToast('Unsaved form restored');
    }

    updateSyncStatus();
    setInterval(syncQueue, SYNC_INTERVAL_MS);
    setInterval(() => { if (screens.survey.classList.contains('active')) { updateAutoInfo(); updateGpsStatus(); } }, 15000);
    if (!isBackendConfigured()) setTimeout(() => showToast('Apps Script URL not set: data is kept on this device only', 'error'), 600);
    syncQueue();
}

init();
