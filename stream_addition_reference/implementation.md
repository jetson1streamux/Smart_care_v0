# Stream Addition and WebRTC Flow Implementation Guide

This directory contains the core logic extracted from the StreamUX project for handling camera stream configurations, saving them to the database, and displaying the corresponding WebRTC streams in the web application.

You can use this directory as a reference to implement similar stream management functionality in other projects using an AI agent.

## Core Files Reference

1. **`src/pages/settings_page.cpp`**: Desktop UI for configuring the number of streams and their RTSP URLs.
2. **`src/utils/mongo_client.cpp`**: C++ MongoDB wrapper that handles upserting stream configurations and cleaning up excess streams.
3. **`src/video_stream.cpp`**: Handles decoding and rendering the RTSP streams locally in the GTK desktop application.
4. **`web_app/server.js`**: Node.js backend that provides an API (`GET /api/streams`, `PUT /api/streams/:id`) to interact with the MongoDB `streams` collection.
5. **`web_app/main.js`**: Frontend Web App code that fetches stream configurations and dynamically embeds WebRTC iframe components for each active stream.

---

## 1. Flow: Adding and Saving a Stream (Desktop App)

When a user adds or modifies a stream in the desktop Settings page:

1. **User Input**: The user enters the RTSP URL in the GTK interface (`src/pages/settings_page.cpp`).
2. **Local Config**: Upon clicking "Apply Settings" (`on_save_settings`), the app validates the URL using regex and saves it to a local `config.ini` file (`Config::getInstance().set(...)`).
3. **Database Sync**: The app synchronizes the new RTSP URL to the MongoDB database by calling `MongoClient::getInstance().updateStreamUrl(user_db, i, new_rtsp)`.
    - This performs a MongoDB `$set` with `{ upsert: true }` in the `streams` collection.
4. **Cleanup**: It also calls `MongoClient::getInstance().deleteExcessStreams()` to remove any trailing streams if the user reduced the total camera count.
5. **Backend Restart Trigger**: A UDP broadcast is sent (`trigger_backend_restart()`) to signal the AI backend (e.g., DeepStream/MediaMTX on a Jetson device) to reload its stream configuration.

---

## 2. Flow: Serving Stream Data to the Web App (Node.js API)

The web application accesses the configured streams via a REST API.

1. **Express Server**: `web_app/server.js` connects to the same MongoDB instance.
2. **API Endpoint**: It defines `GET /api/streams?db=<db_name>`.
3. **Fetching Data**: The endpoint queries the `streams` collection:
   ```javascript
   const coll = client.db(db_name).collection('streams');
   const streams = await coll.find({}).sort({ order_index: 1 }).toArray();
   ```
4. **Response**: It returns an array of stream objects containing `stream_id`, `rtsp_url`, and importantly, `webrtc_url` (if available).

---

## 3. Flow: Displaying WebRTC in the Web App (Frontend)

The Web App dynamically generates video players for the configured streams.

1. **Fetching Streams**: In `web_app/main.js`, `getStreams()` is called when navigating to the Console page.
2. **Grid Generation**: The `renderStream()` function builds a responsive grid (`.video-grid`).
3. **WebRTC Iframe Embedding**: For each stream, it inserts an `iframe` that points to the WebRTC streaming server (typically MediaMTX).
   ```javascript
   <iframe src="${s.webrtc_url || CONFIG.WEBRTC_BASE + '/stream' + (s.stream_id + 1) + '/'}" 
           allow="autoplay" allowfullscreen 
           style="width:100%;height:100%;border:none;object-fit:cover;display:block">
   </iframe>
   ```
   *Note*: If a specific `webrtc_url` is not stored in the DB, it falls back to a constructed URL using a base configured WebRTC host (`CONFIG.WEBRTC_BASE`) and the `stream_id`.
4. **Overlays**: An HTML5 `<canvas>` is overlaid on top of the iframe to draw Region of Interest (ROI) polygons and Line Crossing markers based on the stream's analytics configuration.

---

## Implementing in a New Project

To replicate this in a new project:

1. **Database Schema**: Ensure your database has a `streams` collection (or table) with fields for `stream_id`, `rtsp_url`, and `webrtc_url`.
2. **Settings UI**: Build an interface to accept camera URLs and save them to your database (similar to `settings_page.cpp`).
3. **Media Server**: Set up a server like MediaMTX that can ingest the RTSP URLs and expose them via WebRTC endpoints (e.g., `http://<ip>:8889/stream1/`).
4. **Web Frontend**: Fetch the configured streams from your database via an API, and render them using `iframe` tags pointing to your Media Server's WebRTC endpoints (similar to `main.js`).
