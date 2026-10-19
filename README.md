# KMTT Walkability Survey

Offline-first PWA for the **KMTT Walkability Improvement Feasibility Study** pedestrian interview (questionnaire "OD questionnaire Updated Krishna for Alleyways"). One form per interview; answers go to a Google Sheet through Google Apps Script.

## How an enumerator uses it

1. **Setup:** enter the **Enumerator** name only, then **Start Survey**. There is no location to enter.
2. **Recorded automatically for every interview:**
   - **Location**: the phone's GPS position when the interview is saved (latitude, longitude, accuracy and a Google Maps link). The phone keeps tracking in the background, so saving is never held up. The chip at the top shows the accuracy (e.g. "GPS ±12 m"). If there is no fix within about 8 seconds, the interview is still saved and marked `stale` (last known position) or `unavailable`.
   - **Interview ID**: enumerator initials, date and a counter on this phone, e.g. `KW-20261019-003`. Undoing the last interview frees its number.
   - **Date and time.**
3. **Questions** (numbered as in the questionnaire; follow-ups appear only when they apply):

   | Section | Questions |
   |---|---|
   | A. Respondent and current trip | 1 gender, 1a vulnerability (observed), 1b difficulties · 2 age · 3 relationship to the area · 4 trip purpose · 5 origin · 6 destination · 7 how often · 8 difficulty walking → 8a what makes it difficult · 9 accompanying / assisting |
   | B. Travel modes and walking route | 10 mode entering · 11 mode leaving · 12 entry facility → 12a entry location; 12b expected exit facility → 12c exit location · 13 route on the map, 13a landmarks in order · 14 why this route (**up to two**) · 15 walking time · 16 underpass used → 16a available? → 16b why not |
   | C. Walking barriers and priorities | 17 barriers → 17a personal safety concern (optional) · 18 main barrier (**chosen from the barriers ticked in 17**), 18a where · 19 improvements (**up to three**) · 20 first priority (**chosen from the improvements ticked in 19**) |

4. **Q13 route map:** tap the start, each turn and the end; each part follows the footpaths/streets. The **Walked so far / Planned** button switches what the next taps mark: walked = solid blue, planned (still to walk) = dashed orange. A blue dot shows the interview location. Full screen, satellite / street map and a place search work as in the Pedestrian O-D app.
5. **Save interview.** A half-filled form survives closing the app. **Undo** deletes the last saved interview (until it has been sent). **End** finishes the survey.

## Data (sheet tab `kmtt-walkability`)

Interview ID, Enumerator, Date, Time, **GPS Lat / Lon / Accuracy (m) / Fix Time / Status**, Interview Location Map Link, then one column per question (places with Lat / Lon where a map suggestion was picked), Route Length / Walked / Planned (m), Route Map Link, Route Points (`lat,lon,W|P`), Route Path (encoded polyline), EventID.

Multiple answers are separated by `; `; "Other" answers are saved as `Other: <text>`. The sheet menu **KMTT Walkability → Build / refresh summary** counts every answer, overall and per survey date (including how many interviews were saved without GPS).

## Changing the questions

All option lists are in the `FORM` list at the top of [`app.js`](app.js). If you add or rename a question, also update `COLUMNS` in the backend. Study-area places offered in the place boxes are `presetLocations` in [`config.js`](config.js).

## Deployment

1. **Backend:** new Google Sheet → Extensions → Apps Script → paste [`backend/kmtt_walkability_apps_script.js`](backend/kmtt_walkability_apps_script.js) → run `setup` once → Deploy → New deployment → Web app (Execute as: Me, Access: Anyone) → copy the `/exec` URL.
2. Paste the URL into `appsScriptUrl` in [`config.js`](config.js).
3. **Frontend:** push this folder to its own GitHub repo and connect it to Netlify (no build command, publish directory `.`). The site must be served over HTTPS for the phone's GPS to work.
4. After changing app files, bump `CACHE_NAME` in [`sw.js`](sw.js).
