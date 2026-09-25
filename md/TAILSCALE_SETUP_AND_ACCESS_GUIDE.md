# SmartCare RBATPM — Tailscale Remote Access & Integration Guide

This guide provides step-by-step instructions for client developers integrating the SmartCare RBATPM Web Dashboard and REST APIs into their applications over **Tailscale VPN** (specifically for **Windows** users).

---

## 🚀 Step 1: Install & Set Up Tailscale on Windows

1. **Download Tailscale for Windows**:
   * Visit the official download page: [https://tailscale.com/download/windows](https://tailscale.com/download/windows)
   * Download and run the `Tailscale-setup.exe` installer.

2. **Log In to Tailscale**:
   * Once installed, click the **Tailscale icon** (system tray near the clock).
   * Click **Log In** and authenticate using the credentials / invitation link provided by the RBATPM administrator.

3. **Verify Connection**:
   * Open Windows Command Prompt (`cmd`) or PowerShell and ping the RBATPM server's Tailscale IP or node name:
     ```cmd
     ping <TAILSCALE_IP>
     ```
   * *Example:* `ping 100.x.y.z`

---

## 🌐 Step 2: Accessing the Web Application in Browser

Once connected to Tailscale, open any web browser (Chrome, Edge, Firefox) and use the following URLs:

| Target Resource | Tailscale Browser URL | Purpose |
|---|---|---|
| **Web Dashboard UI** | **`http://<TAILSCALE_IP>:5000/`** | Main Single Page Application for live monitoring, alerts queue, and audit triage. |
| **Interactive FastAPI Docs** | **`http://<TAILSCALE_IP>:5000/docs`** | Live Swagger UI page for testing and inspecting APIs interactively. |
| **ReDoc API Documentation** | **`http://<TAILSCALE_IP>:5000/redoc`** | Formal structured API specification documentation. |
| **OpenAPI Schema (JSON)** | **`http://<TAILSCALE_IP>:5000/openapi.json`** | Raw OpenAPI JSON spec for generating SDKs or Postman collections. |

*Replace `<TAILSCALE_IP>` with the actual Tailscale IP address assigned to the Jetson edge server (e.g., `100.110.120.130`).*

---

## 🔌 Step 3: API Integration for Client Applications

Client applications (Frontend web apps, POS desktop apps, back-office ERPs) can send HTTP requests over the Tailscale network using the base URL:

```
http://<TAILSCALE_IP>:5000
```

### Key API Endpoint Examples over Tailscale:

#### 1. Trigger Transaction Start
```http
POST http://<TAILSCALE_IP>:5000/api/v1/transaction/start
Content-Type: application/json

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

#### 2. Trigger Transaction End
```http
POST http://<TAILSCALE_IP>:5000/api/v1/transaction/end
Content-Type: application/json

{
  "transaction_id": "TXN_ABC123",
  "amount": 6500.0
}
```

#### 3. Fetch Alerts List
```http
GET http://<TAILSCALE_IP>:5000/api/v1/alerts
```

#### 4. Live Stream preview directly in client `<img>` tag:
```html
<img src="http://<TAILSCALE_IP>:5000/api/v1/live-stream?camera_id=CAM01" alt="Live CCTV Feed" />
```

---

## 🛠️ Troubleshooting & Firewall Notes

* **Port Access**: Ensure Windows Firewall permits outbound connections on port `5000` over the Tailscale network interface.
* **CORS Support**: The RBATPM backend has Cross-Origin Resource Sharing (`CORS`) enabled (`allow_origins=["*"]`), allowing your client applications (Web/React/Vue/Electron) to make direct `fetch()` or `axios` API calls without domain restrictions.
