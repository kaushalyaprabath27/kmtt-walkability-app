// Settings for this deployment. Edit here, not in app.js.
window.KMTT_CONFIG = {
    // Google Apps Script Web App URL (Deploy > Manage deployments, ends in /exec).
    // Until this is set, responses are kept safely on the device and are NOT sent.
    appsScriptUrl: 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE',

    // Optional. Leave empty to use free OpenStreetMap place suggestions.
    googlePlacesApiKey: '',

    // Place suggestions are limited to this box: [west, south, east, north] (Sri Lanka).
    placeSearchBbox: [79.4, 5.8, 82.0, 10.0],
    placeSearchCountry: 'lk',

    // Survey area. Suggestions near the interview's GPS position come first
    // (the area centre below until the phone has a fix).
    surveyAreaName: 'KMTT, Kandy',

    // Study-area locations offered first as you type an origin, destination,
    // entry / exit point, landmark or barrier location (tap an empty box to see all).
    presetLocations: [
        'Bogambara TT',
        'SWRD Bandaranayake Mw TT',
        'Clock Tower TT',
        'Torrington TT',
        'Prison Front TT',
        'Front of Swarnamahal TT',
        'Kachcheriya (DS) TT',
        'Infront of Dalada Maligawa',
        'Kandy DS office',
        'Kandy Municipal Council',
        'Kandy Hospital (Hanthana Entrance)',
        'Kandy Hospital (WGM Entrance)',
        'Municipal Central Market'
    ],
    surveyAreaCenter: { lat: 7.2906, lon: 80.6337 },


    // Route map: the survey area, shown as a dashed yellow box,
    // [west, south, east, north] (Kandy town).
    mapBounds: [80.618, 7.276, 80.655, 7.308],
    // The map can be moved, searched and tapped anywhere inside this larger
    // area (all of Sri Lanka), [west, south, east, north], and zoomed out
    // as far as mapMinZoom (7 shows the whole island on a phone).
    mapOuterBounds: [79.4, 5.8, 82.0, 10.0],
    mapMinZoom: 7,
    // Map shown first: 'satellite' or 'street'.
    mapDefaultLayer: 'satellite'
};
