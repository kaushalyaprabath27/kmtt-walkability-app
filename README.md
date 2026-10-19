# KMTT Walkability Survey

Offline-first PWA for the **KMTT Walkability Improvement Feasibility Study** pedestrian interview (questionnaire "OD questionnaire Updated Krishna for Alleyways"). One form per interview; answers go to a Google Sheet through Google Apps Script.

## How an enumerator uses it

1. **Setup:** enter the **Enumerator** name only, then **Start Survey**. There is no location to enter.
2. **Recorded automatically for every interview:**
   - **Location**: the phone's GPS position when the interview is saved (latitude, longitude, accuracy and a Google Maps link). The phone keeps tracking in the background, so saving is never held up. The chip at the top shows the accuracy (e.g. "GPS ±12 m"). If there is no fix within about 8 seconds, the interview is still saved and marked `stale` (last known position) or `unavailable`.
   - **Interview ID**: enumerator initials, date and a counter on this phone, e.g. `KW-20261019-003`. Undoing the last interview frees its number.
   - **Date and time.**
3. **Questions**, in three sections (follow-ups appear only when they apply):

   | Section | Questions |
   |---|---|
   | About you | 1 gender (observed) · 2 age · 3 vulnerability (observed) · 4 difficulties · 5 main purpose of this trip (Work and Business listed separately) · 6 which best describes you (trip category from the Pedestrian O-D app) · 7 accompanying / assisting anyone (incl. Baby, Young child) |
   | This trip | 8 where the trip started · 9 main destination · 10 how often they walk this path · 11 how they got to the **start of the walking trip** (None = walked) → 11a bus stand / terminal, 11b bus route (when Bus) · 12 how they will travel **after the end of the walking trip** → 12a, 12b (when Bus) · 13 why this path (**up to two**) · 14 walking time on this trip |
   | The walking path | 15 difficulties on this path (vehicles parked on the path, motorcycles / three-wheelers on the path, goods / vendors, narrow, broken surface, steps / slope, open drains, lighting, garbage, shade, crowding, crossing at the path ends, personal safety; + optional notes) → 15a safety concern (optional) · 16 the difficulty that affects them most (**chosen from those ticked in 15**), 16a where · 17 improvements (**up to three**, + optional notes) · 18 first priority (**chosen from those ticked in 17**) |

   **Bus routes** (11b, 12b) suggest the `busRoutes` list in [`config.js`](config.js), routes used before, and **any Sri Lankan town as a route** (typing *bad* offers *Badulla – Kandy* for 11b, *Kandy – Badulla* for 12b); any route can still be typed. Bus stands (11a, 12a) suggest the study-area list, stands used before and map places.

4. **Save interview.** A half-filled form survives closing the app. **Undo** deletes the last saved interview (until it has been sent). **End** finishes the survey.

## Data (sheet tab `kmtt-walkability`)

Interview ID, Enumerator, Date, Time, **GPS Lat / Lon / Accuracy (m) / Fix Time / Status**, Interview Location Map Link, then one column per question in form order (places with Lat / Lon where a map suggestion was picked; bus stand and route next to each mode; notes next to their question), EventID.

Multiple answers are separated by `; `; "Other" answers are saved as `Other: <text>`. The sheet menu **KMTT Walkability → Build / refresh summary** counts every answer, overall and per survey date (including how many interviews were saved without GPS).

## Changing the questions

All option lists are in the `FORM` list at the top of [`app.js`](app.js). If you add or rename a question, also update `COLUMNS` in the backend. Study-area places offered in the place boxes are `presetLocations` in [`config.js`](config.js).

## Deployment

1. **Backend:** new Google Sheet → Extensions → Apps Script → paste [`backend/kmtt_walkability_apps_script.js`](backend/kmtt_walkability_apps_script.js) → run `setup` once → Deploy → New deployment → Web app (Execute as: Me, Access: Anyone) → copy the `/exec` URL.
2. Paste the URL into `appsScriptUrl` in [`config.js`](config.js).
3. **Frontend:** push this folder to its own GitHub repo and connect it to Netlify (no build command, publish directory `.`). The site must be served over HTTPS for the phone's GPS to work.
4. After changing app files, bump `CACHE_NAME` in [`sw.js`](sw.js).
