# ROI (Region of Interest) Implementation Guide

This document explains the components and logic necessary to implement the ROI drawing, saving, and real-time viewing functionality in another web application, based on the provided files.

## Overview

Implementing ROI includes three main phases:
1. **Frontend Configuration (Drawing & UI)**: Allowing the user to draw polygons on an HTML5 canvas over a reference frame.
2. **Backend Storage (Persistence & Pipeline Config)**: Saving the coordinate configuration securely in the database and formatting it for backend AI pipelines.
3. **Frontend Visualization (Live Updating UI)**: Overlaying the saved shapes onto real-time video streams and updating object counts dynamically.

## 1. Frontend Configuration (Drawing UI)

**File Reference**: `Settings.jsx` or the settings section in `main.js`

### A. State Management
You need variables to manage the current shape being drawn, and the confirmed list of ROIs.
```javascript
const [anConfigs, setAnConfigs] = useState({ rois: [], lines: [], config_width: 1280, config_height: 720 });
const [anShapeType, setAnShapeType] = useState('roi');
const [anDrawPoints, setAnDrawPoints] = useState([]);
```

### B. HTML5 Canvas Implementation
Render a `<canvas>` element layered over your video or background image frame.
Listen to mouse events to draw shapes:

* **Mouse Down**: Add a point to `anDrawPoints`.
* **Mouse Move**: If drawing, draw a temporary line from the last point to the mouse cursor.
* **Right Click (Context Menu)**: Cancel drawing.

```javascript
// Drawing the stored ROIs
ctx.beginPath();
anConfigs.rois.forEach(roi => {
  if (!roi.coords || roi.coords.length < 6) return; // Need at least 3 points (x,y pairs)
  ctx.moveTo(roi.coords[0], roi.coords[1]);
  for (let i = 2; i < roi.coords.length; i += 2) {
    ctx.lineTo(roi.coords[i], roi.coords[i+1]);
  }
  ctx.closePath();
  ctx.strokeStyle = '#10b981'; // Green color for ROI
  ctx.stroke();
  ctx.fillText(roi.name, roi.coords[0], roi.coords[1] - 10);
});
```

### C. Adding a Shape
When the user confirms the shape (e.g., clicking a "Save Shape" button):
```javascript
if (anShapeType === 'roi' && anDrawPoints.length < 6) {
    alert('ROI requires at least 3 points');
    return;
}
const updated = { ...anConfigs };
updated.rois.push({ name: shapeName, coords: anDrawPoints });
setAnConfigs(updated);
setAnDrawPoints([]); // Reset for next drawing
```

## 2. Backend Storage (Persistence)

**File Reference**: `server.js`

You need endpoints to fetch the existing configuration and save the updated one.

### A. Fetching Configurations (`GET /api/settings/analytics`)
Read from your DB and construct an array of ROI objects containing the name and the coordinates.

```javascript
let rois = [];
// Assuming doc.data contains your stream configuration
if (doc.data[roiKey]) {
  for (const [k, v] of Object.entries(doc.data[roiKey])) {
    if (k.startsWith('roi-')) {
      const name = k.replace('roi-', '');
      const coords = v.split(';').map(Number); // Convert string 'x;y;x;y' back to numbers
      rois.push({ name, coords, count: 0 }); 
    }
  }
}
res.json({ rois, config_width, config_height });
```

### B. Saving Configurations (`POST /api/settings/analytics`)
Transform the frontend data structure into whatever format your AI pipeline (e.g., DeepStream) requires and store it in your DB.

```javascript
const { rois, config_width, config_height } = req.body;
const roiSection = {};

if (rois && rois.length > 0) {
  roiSection['enable'] = '1';
  rois.forEach(roi => {
    // Joining coords array into semi-colon separated string
    roiSection[`roi-${roi.name}`] = roi.coords.join(';'); 
  });
}
// Save roiSection to MongoDB or your database
```

## 3. Frontend Visualization (Live UI overlay)

**File Reference**: `main.js`

To show the ROIs on the live camera stream and display dynamic values (like the number of people inside), you need to scale the coordinates and render them via `requestAnimationFrame` or via your stream-polling loop.

### A. Coordinate Scaling
Camera resolutions might differ from your frontend canvas view sizes. You need transformation functions `tx` and `ty`.
```javascript
// Calculate scaling factor between the original config dimensions and the current canvas size
const scaleX = canvas.width / liveConfig.config_width;
const scaleY = canvas.height / liveConfig.config_height;

const tx = (x) => x * scaleX;
const ty = (y) => y * scaleY;
```

### B. Drawing the Overlay
In your stream render loop (e.g., as soon as a new frame or new metadata payload arrives):
```javascript
if (liveConfig.rois) {
  liveConfig.rois.forEach(roi => {
    if (!roi.coords || roi.coords.length < 6) return;
    
    ctx.beginPath();
    ctx.moveTo(tx(roi.coords[0]), ty(roi.coords[1]));
    for (let i = 2; i < roi.coords.length; i += 2) {
      ctx.lineTo(tx(roi.coords[i]), ty(roi.coords[i+1]));
    }
    ctx.closePath();
    
    // Draw polygon
    ctx.fillStyle = 'rgba(16, 185, 129, 0.2)'; // Transparent fill
    ctx.fill();
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Display Name and Dynamic Count
    const display_text = `${roi.name} (${roi.count || 0})`;
    ctx.fillStyle = '#fff';
    ctx.fillText(display_text, tx(roi.coords[0]), ty(roi.coords[1]) - 4);
  });
}
```

## Summary
1. The **Settings component** uses HTML Canvas to collect `(x, y)` coordinate arrays via mouse clicks.
2. The **Node Server** translates these coordinates into database records suitable for the backend analytics pipeline.
3. The **Main Stream UI** uses aspect-ratio scaling (`tx`/`ty`) to re-draw the shapes accurately on top of the live stream alongside real-time statistics.
