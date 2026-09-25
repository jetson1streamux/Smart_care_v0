# SmartCare RBATPM — Complete REST API Integration Manual (17 Endpoints)

This document contains the exhaustive technical specification for all **17 active REST API endpoints** provided by the SmartCare Risk-Based Action Tracking & Proactive Monitoring (RBATPM) backend.

---

## 🌐 Server Base URL & Environment Configuration

All API requests are made against the RBATPM edge server or cloud instance:

* **Base URL Pattern:** `http://<SERVER_IP>:<PORT>` or `http://<TAILSCALE_IP>:<PORT>`
* **Default Port:** `5000` (Configured in `config.ini` under `[server] port = 5000`)
* **Interactive FastAPI Documentation Page (Swagger UI):** `http://<SERVER_IP>:5000/docs`
* **ReDoc Specification Page:** `http://<SERVER_IP>:5000/redoc`

> 📌 **Note:** Replace `<SERVER_IP>` with your actual server IP, localhost, or Tailscale IP (e.g. `100.x.y.z`).

---

## 📋 Comprehensive API Endpoints Reference

Below is the detailed documentation for all 17 APIs grouped by functional category.

---

### 1. Transaction Management APIs

#### 1.1 🟢 Start Transaction Recording
* **Method:** `POST`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/transaction/start`
* **Description:** Initiates a new transaction on a counter. Evaluates initial risk score based on action type and triggers camera stream buffer recording. (Final transaction amount is submitted when calling `/api/v1/transaction/end`).
* **Headers:** `Content-Type: application/json`
* **Request Body:**
```json
{
  "staff_id": "STF102",
  "counter_id": "Billing Desk 1",
  "module": "Billing",
  "action_type": "Refund",
  "subscription": "Y",
  "pre_buffer_sec": 5,
  "post_buffer_sec": 5
}
```
* **Success Response (200 OK):**
```json
{
  "status": "recording_started",
  "transaction_id": "TXN_8F3A12B4",
  "clip_id": "clip_4a901e8d"
}
```

#### 1.2 🔴 End Transaction Recording & Trigger AI Inference
* **Method:** `POST`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/transaction/end`
* **Description:** Signals transaction completion with final transaction amount. Updates transaction record amount, re-evaluates rule risk score, captures post-buffer frames, transcodes video to H.264 MP4, and triggers background YOLOv8 person detection within drawn ROI zones.
* **Headers:** `Content-Type: application/json`
* **Request Body:**
```json
{
  "transaction_id": "TXN_8F3A12B4",
  "amount": 6500.0
}
```
* **Success Response (200 OK):**
```json
{
  "status": "recording_stopped",
  "transaction_id": "TXN_8F3A12B4"
}
```

#### 1.3 🟡 Trigger Transaction (Legacy Single Call)
* **Method:** `POST`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/transaction`
* **Description:** Legacy wrapper that combines transaction start and auto-ends recording after 3 seconds.
* **Headers:** `Content-Type: application/json`
* **Request Body:** *(Same as `POST /api/v1/transaction/start`)*
* **Success Response (200 OK):** `{"status": "recording_started", "transaction_id": "TXN_8F3A12B4", "clip_id": "clip_4a901e8d"}`

---

### 2. Analytics & Auditing APIs

#### 2.1 📊 Get All Alert Logs
* **Method:** `GET`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/alerts`
* **Description:** Returns all transaction alerts, risk scores, video clip URLs, YOLO person presence results, camera health states, and audit trails.
* **Success Response (200 OK):**
```json
[
  {
    "id": 1,
    "transaction_id": "TXN_8F3A12B4",
    "staff_id": "STF102",
    "counter_id": "Billing Desk 1",
    "module": "Billing",
    "action_type": "Refund",
    "amount": 6500.0,
    "timestamp": "2026-08-03T12:00:00",
    "risk_score": "High",
    "clip_id": "clip_4a901e8d",
    "clip_url": "/clips/clip_4a901e8d.mp4",
    "recording_status": "Ready",
    "camera_health": "Online",
    "person_present": 0,
    "person_count": 0,
    "presence_duration_sec": 0.0,
    "clip_duration_sec": 10.0,
    "flag": "alert",
    "reviewer_status": "Pending",
    "reviewer_remarks": null,
    "reviewer_time": null,
    "audit_logs": "[{\"time\":\"12:00:00\",\"msg\":\"Transaction initiated\"}]"
  }
]
```

#### 2.2 ✍️ Save Auditor Disposition
* **Method:** `POST`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/alerts/{alert_id}/disposition`
* **Example URL:** `http://<SERVER_IP>:5000/api/v1/alerts/1/disposition`
* **Description:** Used by human auditors to record their verdict (`Verified-Clean`, `Verified-Discrepancy`, `Escalated`) and narrative remarks.
* **Headers:** `Content-Type: application/json`
* **Request Body:**
```json
{
  "remarks": "Audited video clip. Desk was unattended during refund authorization.",
  "outcome": "Verified-Discrepancy"
}
```
* **Success Response (200 OK):** `{"status": "success"}`

#### 2.3 🖥️ Get Registered Counters List
* **Method:** `GET`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/counters`
* **Description:** Returns all registered counters, mapped camera IDs, subscription toggle state, and real-time health status.
* **Success Response (200 OK):**
```json
[
  {
    "id": 1,
    "counter_id": "Billing Desk 1",
    "camera_id": "CAM01",
    "subscription": 1,
    "health": "Online"
  }
]
```

#### 2.4 🔘 Toggle Counter Subscription
* **Method:** `POST`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/counters/{counter_id}/subscription`
* **Example URL:** `http://<SERVER_IP>:5000/api/v1/counters/Billing%20Desk%201/subscription`
* **Description:** Enables or disables video recording subscription for a counter.
* **Headers:** `Content-Type: application/json`
* **Request Body:**
```json
{
  "active": true
}
```
* **Success Response (200 OK):** `{"status": "success"}`

---

### 3. Video Streaming & Verification APIs

#### 3.1 🎥 Get WebRTC Stream URL
* **Method:** `GET`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/webrtc-url`
* **Query Parameter:** `?camera_id=CAM01`
* **Description:** Returns low-latency WebRTC stream URL powered by MediaMTX for browser video players.
* **Success Response (200 OK):**
```json
{
  "webrtc_url": "http://100.94.110.18:8889/cam1/",
  "camera_id": "CAM01",
  "stream_name": "cam1"
}
```

#### 3.2 📹 Get Stream URL Configuration
* **Method:** `GET`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/stream-url`
* **Query Parameter:** `?camera_id=CAM01`
* **Description:** Returns configured internal stream source location.
* **Success Response (200 OK):** `{"url": "rtsp://admin:Admin@192.168.0.101/..."}`

#### 3.3 📺 Live MJPEG Stream Feed
* **Method:** `GET`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/live-stream`
* **Query Parameter:** `?camera_id=CAM01`
* **Description:** Returns continuous multipart MJPEG stream feed consumable directly by standard HTML `<img src="...">` tags.

#### 3.4 🖼️ Get Latest Frame Snapshot
* **Method:** `GET`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/latest-frame.jpg`
* **Query Parameter:** `?camera_id=CAM01`
* **Description:** Captures single latest JPEG image snapshot with timestamp overlay.

#### 3.5 📐 Get ROI Clean Reference Frame
* **Method:** `GET`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/roi-frame/{camera_id}`
* **Example URL:** `http://<SERVER_IP>:5000/api/v1/roi-frame/CAM01`
* **Description:** Returns a clean full-resolution snapshot (without date/time overlay) specifically for use as ROI drawing canvas background.

---

### 4. Region of Interest (ROI) Configuration APIs

#### 4.1 🔍 Get Camera ROI Configurations
* **Method:** `GET`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/roi/{camera_id}`
* **Example URL:** `http://<SERVER_IP>:5000/api/v1/roi/CAM01`
* **Description:** Fetches saved ROI polygon coordinates and canvas dimensions for a camera.
* **Success Response (200 OK):**
```json
{
  "camera_id": "CAM01",
  "config_width": 1280,
  "config_height": 720,
  "rois": [
    {
      "name": "Counter Zone 1",
      "coords": [100, 200, 400, 200, 400, 500, 100, 500]
    }
  ]
}
```

#### 4.2 💾 Save Camera ROI Configurations
* **Method:** `POST`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/roi/{camera_id}`
* **Example URL:** `http://<SERVER_IP>:5000/api/v1/roi/CAM01`
* **Headers:** `Content-Type: application/json`
* **Request Body:**
```json
{
  "rois": [
    {
      "name": "Counter Zone 1",
      "coords": [100, 200, 400, 200, 400, 500, 100, 500]
    }
  ],
  "config_width": 1280,
  "config_height": 720
}
```
* **Success Response (200 OK):** `{"status": "success", "count": 1}`

#### 4.3 🗑️ Delete Specific ROI Polygon
* **Method:** `DELETE`
* **Endpoint URL:** `http://<SERVER_IP>:5000/api/v1/roi/{camera_id}/{roi_name}`
* **Example URL:** `http://<SERVER_IP>:5000/api/v1/roi/CAM01/Counter%20Zone%201`
* **Description:** Deletes a single ROI polygon zone by name.
* **Success Response (200 OK):** `{"status": "success"}`

---

### 5. System & Legacy APIs

#### 5.1 🌐 Web Dashboard UI Interface
* **Method:** `GET`
* **Endpoint URL:** `http://<SERVER_IP>:5000/`
* **Description:** Serves the monolithic Single Page Application UI from backend natively.

#### 5.2 📤 Image Upload Inference (Legacy)
* **Method:** `POST`
* **Endpoint URL:** `http://<SERVER_IP>:5000/upload-images`
* **Headers:** `Content-Type: multipart/form-data`
* **Request Body:** File Upload (`file`)
* **Success Response (200 OK):** `{"id": 1, "confidence": 0.9421}`
