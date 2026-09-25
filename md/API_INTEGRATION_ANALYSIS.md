# SmartCare RBATPM - Client API Integration Analysis & Response Guide

---

## 1. Executive Summary

This document provides a comprehensive technical analysis of the SmartCare Risk-Based Action Tracking & Proactive Monitoring (RBATPM) API integration for the client's Hospital CRM system. It clarifies the division of responsibility between the Hospital CRM and the SmartCare Jetson Edge Appliance, evaluates the client's current 4-API implementation, outlines integration paths for the new **"SmartCare Button"**, and provides a copy-pasteable response to send to the client.

---

## 2. System Architecture & Division of Responsibility

The SmartCare system is built as an **autonomous Edge-AI Video Analytics Engine**. The Jetson appliance continuously executes resource-intensive computer vision tasks, background video processing, and risk management in real time.

```
+------------------------------------+           +-----------------------------------------+
|     Hospital CRM Application       |           |   SmartCare Edge Appliance (Jetson)     |
|      (Frontend / Client Side)      |           |          (Backend Server)              |
+------------------------------------+           +-----------------------------------------+
|  • Triggers Transaction Start      |  =======> |  • Receives REST API calls              |
|  • Triggers Transaction End        |   REST    |  • Captures live CCTV RTSP feeds        |
|  • Passes Staff ID, Counter, Amt   |   APIs    |  • Buffers video (Pre/Post buffer)      |
|  • Opens SmartCare Button / Feed   |           |  • Transcodes video via FFMPEG (H.264)  |
|                                    |           |  • Runs YOLOv8 GPU Person Detection     |
|                                    |           |  • Evaluates Risk & ROI collision math  |
|                                    |           |  • Auto-cleans expired clips & timeouts |
+------------------------------------+           +-----------------------------------------+
```

### Tasks Executed Automatically by Jetson Server (No Client API Coding Required)
1. **RTSP Stream Management & Buffer Handling:** Maintains continuous 15-second rolling frame buffers per camera.
2. **Video Snippet Generation:** Extracts pre-buffer and post-buffer frames and writes `.mp4` video clips.
3. **Background Transcoding:** Converts video clips to web-compatible H.264 baseline profile using FFMPEG.
4. **YOLOv8 GPU Inference:** Runs object detection to determine person presence within configured Region of Interest (ROI) polygons.
5. **Rule Engine & Risk Assessment:** Automatically updates alert risk levels (`High`, `Medium`, `Low`) based on amount thresholds, presence/absence, or camera offline monitoring gaps.
6. **Maintenance & Safety:** Runs a 60-second watchdog auto-timeout and a clip janitor background thread to purge old video files based on retention policies.

---

## 3. API Scope Analysis: Are the 4 Initial APIs Enough?

**Verdict: YES.** For core automated background monitoring, integrating the **4 initial APIs is 100% sufficient.**

### The 4 Core APIs Implemented:
1. `POST /api/v1/transaction/start` — Triggered when a hospital billing, refund, or counter transaction begins.
2. `POST /api/v1/transaction/end` — Triggered when the transaction completes (passes final transaction amount).
3. `GET /api/v1/counters` — Fetches registered counter mappings and checks camera health status (`Online`/`Offline`).
4. `GET /api/v1/alerts` — Retrieves logged transaction alerts and flags.

With these 4 endpoints integrated into the Hospital CRM workflow, SmartCare receives all necessary transactional triggers to capture video snippets and execute AI analysis without any further manual intervention.

---

## 4. "SmartCare Button" Integration Options

When adding the **SmartCare Button** inside the Hospital CRM UI, the client can choose one of three implementation strategies based on their desired user experience:

| Option | User Experience / Behavior | APIs Required from CRM | Implementation Effort |
| :--- | :--- | :--- | :--- |
| **Option A: Full SmartCare Portal (Recommended)** | Clicking the button opens the full SmartCare web interface in a new browser tab or embedded `<iframe>`. | **None!** (Redirect to `http://<JETSON_IP>:5000/`) | **Zero extra code** — SmartCare natively handles video playback, alert reviews, and ROI setup. |
| **Option B: Embedded CCTV Live Stream** | Displays a live CCTV preview of the counter directly inside the CRM billing window. | `GET /api/v1/live-stream` (MJPEG `<img src="...">`) or `GET /api/v1/webrtc-url` | **Minimal** — Single HTML element pointing to Jetson stream URL. |
| **Option C: Native CRM Audit & ROI Dashboard** | Recreates SmartCare's review dashboard and ROI polygon drawing tool inside the CRM codebase. | `POST /api/v1/alerts/{id}/disposition`, `GET /api/v1/roi-frame/{cam}`, `POST /api/v1/roi/{cam}` | **High** — Requires building custom video players and canvas UI elements inside CRM. |

---

## 5. Complete API Classification Matrix

| Category | API Endpoint | Primary Operator | CRM Requirement Level |
| :--- | :--- | :--- | :--- |
| **1. Transaction Management** | `POST /api/v1/transaction/start`<br>`POST /api/v1/transaction/end` | Hospital CRM | **MANDATORY** (Triggers video capture & AI) |
| **2. Analytics & Auditing** | `GET /api/v1/counters`<br>`POST /api/v1/counters/{id}/subscription` | Hospital CRM | **RECOMMENDED** (Counter mapping & status verification) |
| **2. Analytics & Auditing** | `GET /api/v1/alerts`<br>`POST /api/v1/alerts/{id}/disposition` | SmartCare UI / Auditor | **OPTIONAL** (Only if auditing inside CRM) |
| **3. Video Streaming** | `GET /api/v1/webrtc-url`<br>`GET /api/v1/live-stream`<br>`GET /api/v1/latest-frame.jpg` | SmartCare UI / Live Stream | **OPTIONAL** (Only if CRM embeds live CCTV player) |
| **4. ROI Configuration** | `GET/POST/DELETE /api/v1/roi/{camera_id}`<br>`GET /api/v1/roi-frame/{camera_id}` | SmartCare Admin | **NOT REQUIRED IN CRM** (Configured via SmartCare Admin UI) |

---

## 6. Client-Facing Response Message (Ready to Share)

Below is the message formatted to send directly to your client:

---

### 💬 Client Response Draft:

> Hi [Client Name],
>
> Great progress on integrating **Section 1 (Transaction Management)** and **Section 2 (Analytics & Auditing)**!
>
> To answer your question directly: **Yes, the 4 initial APIs (`transaction/start`, `transaction/end`, `counters`, and `alerts`) are completely sufficient for core transaction tracking and proactive risk monitoring.**
>
> All heavy backend operations—including continuous CCTV video buffering, pre/post buffer clip saving, FFMPEG video conversion to web formats, YOLOv8 GPU person detection, and risk scoring—are executed automatically by the SmartCare backend on the Jetson appliance.
>
> ---
>
> ### Options for the new "SmartCare Button" in your Hospital CRM:
>
> Depending on what you would like to happen when a user clicks the **SmartCare Button** in your CRM, you can choose one of the following approaches:
>
> #### 🔹 Approach 1: Open Full SmartCare Portal (Recommended & Easiest)
> * **Behavior:** Clicking the button opens the SmartCare Web Dashboard in a new browser tab or embedded `<iframe>`.
> * **APIs Needed:** **None!**
> * **Target URL:** Simply point the button or iframe to `http://<JETSON_IP>:5000/`.
> * **Why:** The built-in SmartCare application natively handles live camera previews, recorded video clip playback, auditor remarks/dispositions, and camera ROI configuration out of the box.
>
> #### 🔹 Approach 2: Embed Live CCTV Feed directly inside the CRM
> * **Behavior:** Show a live preview of the counter's CCTV camera right inside the billing/refund screen.
> * **APIs Needed:**
>   * `GET /api/v1/live-stream?camera_id=CAM01` (Direct MJPEG stream: `<img src="...">`)
>   * `GET /api/v1/webrtc-url?camera_id=CAM01` (For low-latency WebRTC streaming)
>
> #### 🔹 Approach 3: Build Custom Audit & ROI UI natively inside your CRM
> * **Behavior:** Recreate the review panel and ROI configuration canvas inside your CRM code without using SmartCare's built-in UI.
> * **APIs Needed:**
>   * Auditing: `POST /api/v1/alerts/{alert_id}/disposition` (To record auditor verdict & remarks)
>   * ROI Canvas: `GET /api/v1/roi-frame/{camera_id}`, `GET /api/v1/roi/{camera_id}`, `POST /api/v1/roi/{camera_id}`
>
> ---
>
> ### Summary Recommendation:
> 1. Keep your existing 4 transaction/counter APIs active for automated background video tracking.
> 2. For the **SmartCare Button**, configure it to open `http://<JETSON_IP>:5000/` (Approach 1). This gives your users complete access to video reviews, audit logs, and camera ROI configuration immediately with zero extra development!
