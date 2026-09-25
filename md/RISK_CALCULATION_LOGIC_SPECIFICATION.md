# SmartCare RBATPM — Risk Decision Engine & Transaction Risk Logic Specification

**Document Version:** 1.0  
**Target Audience:** Client Technical Leads, Systems Engineers, Audit & Compliance Teams  
**System:** SmartCare Risk-Based Action Tracking & Proactive Monitoring (RBATPM)  
**Classification:** Technical Documentation  

---

## 1. Executive Summary

The **SmartCare Risk-Based Action Tracking & Proactive Monitoring (RBATPM)** platform enforces automated risk classification on Point-of-Sale (POS) transactions across billing counters, pharmacies, and inventory desks. 

Risk evaluation is governed by a **4-Stage Hybrid Risk Engine** combining:
1. **Business Action Rules** (POS transaction classifications).
2. **Monetary Amount Thresholds** (Financial impact limits).
3. **Camera & Infrastructure Health Watchdogs** (Monitoring gap safeguards).
4. **Computer Vision AI Verification** (YOLOv8 GPU-accelerated Region-of-Interest person presence detection).

---

## 2. Risk Engine Architecture & Evaluation Stages

Transaction risk is evaluated dynamically across four sequential stages during the lifecycle of a transaction trigger.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ STAGE 1: Transaction Start (POS Action Rule)                            │
│  • Action = Refund / Override  ───>  Preliminary Risk = MEDIUM           │
│  • Action = Standard Sale      ───>  Preliminary Risk = LOW             │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     v
┌─────────────────────────────────────────────────────────────────────────┐
│ STAGE 2: Hardware & Stream Connectivity Check                           │
│  • Camera Status = OFFLINE     ───>  Escalate to HIGH (Monitoring Gap)  │
│  • Camera Status = ONLINE      ───>  Proceed to Video Capture           │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     v
┌─────────────────────────────────────────────────────────────────────────┐
│ STAGE 3: Transaction Completion (Monetary Amount Thresholds)           │
│  • Amount > ₹5,000             ───>  Risk = HIGH                        │
│  • Amount > ₹2,000 OR Refund   ───>  Risk = MEDIUM                      │
│  • Amount ≤ ₹2,000             ───>  Risk = LOW                         │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     v
┌─────────────────────────────────────────────────────────────────────────┐
│ STAGE 4: AI Computer Vision Audit (YOLOv8 ROI Person Detection)          │
│  • Presence Ratio < 30%        ───>  OVERRIDE RISK TO HIGH (Alert)      │
│  • Presence Ratio ≥ 30%        ───>  RETAIN STAGE 3 RISK (Clean)        │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Stage Breakdown

### Stage 1: Preliminary POS Action Scoring (At Trigger Start)
When a POS transaction begins (`POST /api/v1/transaction/start`), preliminary risk is assigned based on the action type:
* **Medium Risk:** Triggered if `action_type` matches high-sensitivity operational events (e.g., *Cash Refund*, *Discount Override*, *Bill Cancellation*).
* **Low Risk:** Standard POS actions (e.g., *Standard Cash/Card Sale*, *Inventory Issue*).

### Stage 2: Camera Stream & Infrastructure Health Safeguard
Before recording commences, the backend verifies camera availability:
* **High Risk — Monitoring Gap (`flag = "monitoring_gap"`):** If the CCTV camera assigned to the counter is `Offline` or unreachable via RTSP, video evidence cannot be guaranteed. The system immediately logs a **Monitoring Gap** alert, sets `risk_score = "High"`, and notifies audit teams.

### Stage 3: Monetary Threshold Re-Evaluation (At Trigger End)
When the transaction completes (`POST /api/v1/transaction/end`), the backend calculates the final monetary value against configurable threshold boundaries:

| Assigned Risk Level | Rule Condition | Default Threshold Boundaries |
| :--- | :--- | :--- |
| 🚨 **HIGH RISK** | Transaction Amount > High Threshold | **Amount > ₹5,000** |
| ⚠️ **MEDIUM RISK** | Transaction Amount > Medium Threshold **OR** Action Type is Sensitive | **Amount > ₹2,000** or Action = *Refund / Discount Override* |
| ✅ **LOW RISK** | Transaction Amount ≤ Medium Threshold and Standard Action | **Amount ≤ ₹2,000** |

### Stage 4: AI Computer Vision Person-Presence Verification (GPU Worker Pipeline)
Following video capture (including 5s pre-roll and 5s post-roll buffers), the MP4 clip is submitted to a sequential GPU worker running **YOLOv8 object detection**:

1. **Region of Interest (ROI) Mapping:** The system projects the camera's configured 2D polygon zone (`roi_configs`) onto sampled video frames (sampled at 5 FPS).
2. **Detection Evaluation:** For every detected `person` bounding box, the center coordinate $C(x, y) = (\frac{x_1 + x_2}{2}, \frac{y_1 + y_2}{2})$ is evaluated using the Ray-Casting algorithm against the ROI polygon:
   $$\text{Presence Ratio \%} = \left( \frac{\text{Sampled Frames with Person Center in ROI}}{\text{Total Sampled Video Frames}} \right) \times 100$$
3. **Automated Risk Escalation:**
   * **Unattended Counter Detected (Presence Ratio < 30%):** If staff presence falls below 30%, the system flags an **Empty Counter Alert** (`flag = "alert"`) and **escalates the final risk score to HIGH**, overriding any preliminary low/medium score.
   * **Verified Counter Activity (Presence Ratio ≥ 30%):** Staff presence is confirmed. The system marks the transaction as **CLEAN** (`flag = "clean"`) and maintains the Stage 3 calculated risk score.

---

## 4. Master Risk Decision Matrix

| Camera Status | POS Action Type | Transaction Amount (₹) | Staff ROI Presence (≥30%) | Final Risk Score | System Flag | Action Required |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Offline** | Any | Any | N/A | 🚨 **HIGH** | `monitoring_gap` | Immediate Technical Audit |
| **Online** | Any | Any | **No (< 30%)** | 🚨 **HIGH** | `alert` | Mandatory Review (Empty Counter) |
| **Online** | Standard Sale | **> ₹5,000** | **Yes (≥ 30%)** | 🚨 **HIGH** | `clean` | High Value Verification |
| **Online** | Cash Refund / Override | **₹2,001 - ₹5,000** | **Yes (≥ 30%)** | ⚠️ **MEDIUM** | `clean` | Routine Supervisory Review |
| **Online** | Standard Sale | **≤ ₹2,000** | **Yes (≥ 30%)** | ✅ **LOW** | `clean` | Auto-Cleared Log |

---

## 5. Master Configuration Parameters (`config.ini`)

All risk calculation parameters are externalized in `config.ini` and can be adjusted without modifying code:

```ini
[risk_rules]
# Monetary amount thresholds (INR)
high_amount_threshold   = 5000
medium_amount_threshold = 2000

# High-sensitivity action types triggering at least Medium risk
medium_action_types = Refund, Discount Override, Bill Cancellation

[inference]
# Minimum percentage of frames requiring person presence inside ROI
presence_threshold_pct = 30.0

[recording]
default_pre_buffer_sec  = 5
default_post_buffer_sec = 5
```

---

## 6. Audit Trail & Verification Outcomes

Every risk calculation produces a permanent audit log stored in `rbatpm.db`. Auditors can disposition alerts into three outcomes:
1. **Verified Clean:** Confirmed as legitimate transaction with staff present.
2. **Verified Discrepancy:** Process deviation identified (e.g., incorrect refund procedure).
3. **Escalate to Risk:** Potential policy violation or fraud escalated for investigation.
