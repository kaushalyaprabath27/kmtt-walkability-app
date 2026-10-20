/**
 * KMTT WALKABILITY IMPROVEMENT FEASIBILITY STUDY - APPS SCRIPT BACKEND
 *
 * No admin registration or login: every enumerator's interviews go to the
 * one Google Sheet this script is attached to. One row per interview, with
 * the GPS position recorded when the interview was saved.
 *
 * HOW TO DEPLOY:
 * 1. Create a new Google Sheet (e.g. "KMTT Walkability Survey Data").
 * 2. In that sheet: Extensions > Apps Script.
 * 3. Delete the sample code, paste ALL of this file, press Ctrl+S.
 * 4. Select the function "setup" in the toolbar and click Run once
 *    (approve the permissions). This creates the data tab and headers.
 * 5. Deploy > New deployment > type "Web app":
 *      Execute as: Me
 *      Who has access: Anyone
 *    Click Deploy and copy the Web app URL (ends in /exec).
 * 6. Paste that URL into config.js in the app (appsScriptUrl).
 *
 * UPDATING THE CODE LATER:
 *    Deploy > Manage deployments > Edit (pencil) > Version: "New version"
 *    > Deploy. The URL stays the same.
 */

const DATA_SHEET_NAME = "kmtt-walkability";
const SUMMARY_SHEET_NAME = "Summary";

// [sheet header, record field, type]
const COLUMNS = [
  ["Interview ID", "interviewId", "text"],
  ["Enumerator", "name", "text"],
  ["Date", "date", "text"],
  ["Time", "time", "text"],
  ["GPS Lat", "gpsLat", "num"],
  ["GPS Lon", "gpsLon", "num"],
  ["GPS Accuracy (m)", "gpsAccuracyM", "num"],
  ["GPS Fix Time", "gpsFixTime", "text"],
  ["GPS Status", "gpsStatus", "text"],
  ["Interview Location Map Link", "locationMapLink", "long"],
  ["Gender", "gender", "text"],
  ["Age Category", "age", "text"],
  ["Vulnerability (observed)", "vulnerability", "text"],
  ["Difficulties", "difficulties", "long"],
  ["Trip Purpose", "purpose", "text"],
  ["Respondent / Trip Category", "category", "text"],
  ["Accompanying / Assisting", "accompanying", "text"],
  ["Walking Trip Start", "origin", "text"],
  ["Walking Trip Start Lat", "originLat", "num"],
  ["Walking Trip Start Lon", "originLon", "num"],
  ["Walking Trip End", "destination", "text"],
  ["Walking Trip End Lat", "destinationLat", "num"],
  ["Walking Trip End Lon", "destinationLon", "num"],
  ["Walking Frequency", "frequency", "text"],
  ["Mode to Walk Start", "startMode", "text"],
  ["Start Bus Stand / Terminal", "startBusTerminal", "text"],
  ["Start Bus Route", "startBusRoute", "text"],
  ["Mode After Walk End", "endMode", "text"],
  ["End Bus Stand / Terminal", "endBusTerminal", "text"],
  ["End Bus Route", "endBusRoute", "text"],
  ["Path Choice Reasons", "routeReason", "text"],
  ["Walking Time (this trip)", "walkTime", "text"],
  ["Path Difficulties", "pathDifficulties", "long"],
  ["Difficulty Details", "pathDifficultiesNotes", "long"],
  ["Personal Safety Concerns", "safetyConcern", "text"],
  ["Main Difficulty", "mainDifficulty", "text"],
  ["Improvements Prioritised", "improvements", "long"],
  ["Improvement Details", "improvementsNotes", "long"],
  ["First Priority", "firstPriority", "text"],
  ["EventID", "eventId", "text"]
];
const HEADERS = COLUMNS.map(function (c) { return c[0]; });
const EVENT_ID_COL = HEADERS.indexOf("EventID") + 1; // 1-based

// Categorical columns counted on the Summary tab (per survey date).
const SUMMARY_FIELDS = [
  "Gender", "Age Category", "Vulnerability (observed)", "Difficulties", "Trip Purpose", "Respondent / Trip Category",
  "Accompanying / Assisting", "Walking Frequency", "Mode to Walk Start", "Start Bus Stand / Terminal", "Start Bus Route",
  "Mode After Walk End", "End Bus Stand / Terminal", "End Bus Route", "Path Choice Reasons", "Walking Time (this trip)",
  "Path Difficulties", "Personal Safety Concerns", "Main Difficulty", "Improvements Prioritised", "First Priority", "GPS Status"
];
// "; "-separated multi-answer columns
const MULTI_FIELDS = [
  "Vulnerability (observed)", "Difficulties", "Accompanying / Assisting", "Path Choice Reasons", "Path Difficulties",
  "Personal Safety Concerns", "Improvements Prioritised"
];
const SEGMENT_COLUMN = "Date"; // Summary columns: one per survey date

const MAX_BATCH_SIZE = 200;
const GLOBAL_RATE_LIMIT_PER_MIN = 300;
const LOCK_WAIT_MS = 30000;

// ---------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------
function doPost(e) { return handleRequest(e); }
function doGet(e) { return handleRequest(e); }

function handleRequest(e) {
  if (!checkGlobalRateLimit()) {
    return responseJson({ status: "error", message: "Too many requests. Please try again shortly." });
  }
  try {
    let data = {};
    if (e && e.postData && e.postData.contents) {
      try { data = JSON.parse(e.postData.contents); } catch (err) {}
    }
    const params = (e && e.parameter) || {};
    for (const key in params) data[key] = params[key];

    const action = data.action;
    // v3 = current app (revised questionnaire). Earlier versions are still
    // accepted; fields they lack stay blank and retired fields are ignored.
    if (/^submit_kmtt_v[1-3]$/.test(action || "")) return handleSubmitBatch(data);
    if (!action) return responseJson({ status: "success", message: "KMTT walkability survey backend is running." });
    return responseJson({ status: "error", message: "Invalid action" });
  } catch (error) {
    return responseJson({ status: "error", message: error.toString() });
  }
}

// ---------------------------------------------------------------------
// Batch write
// ---------------------------------------------------------------------
function handleSubmitBatch(data) {
  const payload = Array.isArray(data.payload) ? data.payload : [];
  if (payload.length === 0) return responseJson({ status: "success", count: 0, duplicatesSkipped: 0 });
  if (payload.length > MAX_BATCH_SIZE) {
    return responseJson({ status: "error", message: "Batch too large (max " + MAX_BATCH_SIZE + ")." });
  }

  // One writer at a time, so concurrent surveyors never overwrite each
  // other's rows and the duplicate check sees every committed row.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    return responseJson({ status: "error", message: "Server busy. The app will retry automatically." });
  }

  try {
    const sheet = getDataSheet();
    // Idempotency: an eventId already in the sheet is skipped (a batch
    // re-sent after a lost response is not written twice).
    const existing = getExistingEventIds(sheet);

    const rows = [];
    let duplicatesSkipped = 0;
    for (let i = 0; i < payload.length; i++) {
      const item = payload[i];
      if (!item || typeof item !== "object") continue;
      const id = item.eventId ? String(item.eventId) : "";
      if (id && existing[id]) { duplicatesSkipped++; continue; }
      if (id) existing[id] = true;
      rows.push(toRow(item));
    }

    if (rows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
      SpreadsheetApp.flush();
    }
    return responseJson({ status: "success", count: rows.length, duplicatesSkipped: duplicatesSkipped });
  } finally {
    lock.releaseLock();
  }
}

function toRow(item) {
  return COLUMNS.map(function (c) {
    const v = item[c[1]];
    if (c[2] === "num") return num(v);
    // A Sheets cell holds up to 50,000 characters; the route path can be long.
    return text(v, c[2] === "path" ? 45000 : c[2] === "long" ? 2000 : 300);
  });
}

// Plain text only: trims, caps length, and stops a typed value such as
// "=IMPORTXML(...)" from being run as a formula in the sheet.
function text(v, maxLen) {
  if (v === undefined || v === null) return "";
  let s = String(v).trim().slice(0, maxLen || 300);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function num(v) {
  if (v === "" || v === null || v === undefined) return "";
  const n = Number(v);
  return isFinite(n) ? n : "";
}

// ---------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------
function getSpreadsheet() {
  const active = SpreadsheetApp.getActiveSpreadsheet(); // set when attached to a sheet
  if (active) return active;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("SHEET_ID");
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) {}
  }
  const ss = SpreadsheetApp.create("KMTT Walkability Survey Data");
  props.setProperty("SHEET_ID", ss.getId());
  return ss;
}

function getDataSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(DATA_SHEET_NAME);
  if (sheet && !hasCurrentHeaders(sheet)) {
    if (sheet.getLastRow() <= 1) {
      sheet.clear();
    } else {
      // Rows in an older column layout: keep them untouched under a new name.
      sheet.setName(DATA_SHEET_NAME + " (old " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HHmm") + ")");
      sheet = null;
    }
  }
  if (!sheet) sheet = ss.insertSheet(DATA_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function hasCurrentHeaders(sheet) {
  if (sheet.getLastRow() === 0) return true;
  if (sheet.getLastColumn() !== HEADERS.length) return false;
  const row = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  return row.every(function (v, i) { return String(v) === HEADERS[i]; });
}

function getExistingEventIds(sheet) {
  const seen = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return seen;
  const values = sheet.getRange(2, EVENT_ID_COL, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0]) seen[String(values[i][0])] = true;
  }
  return seen;
}

function responseJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkGlobalRateLimit() {
  const cache = CacheService.getScriptCache();
  const key = "global_rate_limit";
  const count = parseInt(cache.get(key) || "0", 10);
  if (count >= GLOBAL_RATE_LIMIT_PER_MIN) return false;
  cache.put(key, String(count + 1), 60);
  return true;
}

// Run once from the editor: creates the data tab + header row and asks for
// the permissions the web app needs.
function setup() {
  const sheet = getDataSheet();
  Logger.log("Data sheet ready: " + sheet.getParent().getUrl());
}

// ---------------------------------------------------------------------
// Summary tab (menu: KMTT Walkability > Build / refresh summary)
// Counts every answer to each categorical question, overall and per survey date.
// ---------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("KMTT Walkability")
    .addItem("Build / refresh summary", "buildSummary")
    .addToUi();
}

function buildSummary() {
  const ss = getSpreadsheet();
  const data = getDataSheet().getDataRange().getValues();
  const col = {};
  HEADERS.forEach(function (h, i) { col[h] = i; });

  const segments = [];
  const counts = {}; // field -> answer -> location -> n
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const seg = String(row[col[SEGMENT_COLUMN]] || "(none)");
    if (segments.indexOf(seg) === -1) segments.push(seg);
    SUMMARY_FIELDS.forEach(function (field) {
      const raw = String(row[col[field]] || "").trim();
      const answers = raw ? (MULTI_FIELDS.indexOf(field) >= 0 ? raw.split("; ") : [raw]) : ["(blank)"];
      answers.forEach(function (a) {
        const key = /^Other:/.test(a) ? "Other" : a; // group "Other: ..." details
        counts[field] = counts[field] || {};
        counts[field][key] = counts[field][key] || {};
        counts[field][key][seg] = (counts[field][key][seg] || 0) + 1;
      });
    });
  }
  segments.sort();

  const out = [["Question", "Answer", "Total"].concat(segments)];
  SUMMARY_FIELDS.forEach(function (field) {
    const byAnswer = counts[field] || {};
    Object.keys(byAnswer).sort(function (a, b) { return total(byAnswer[b]) - total(byAnswer[a]); }).forEach(function (a) {
      out.push([field, a, total(byAnswer[a])].concat(segments.map(function (s) { return byAnswer[a][s] || 0; })));
    });
  });

  let sheet = ss.getSheetByName(SUMMARY_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SUMMARY_SHEET_NAME);
  sheet.clear();
  sheet.getRange(1, 1, out.length, out[0].length).setValues(out);
  sheet.getRange(1, 1, 1, out[0].length).setFontWeight("bold");
  sheet.setFrozenRows(1);
  sheet.getRange(out.length + 2, 1).setValue(
    "Interviews: " + (data.length - 1) + ". Multi-answer questions can add up to more than the number of interviews."
  );
  sheet.autoResizeColumns(1, out[0].length);
}

function total(bySeg) {
  let n = 0;
  for (const k in bySeg) n += bySeg[k];
  return n;
}
