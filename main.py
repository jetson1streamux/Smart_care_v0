import os
import io
import cv2
import cv2
import time
import uuid
import json
import glob
import torch
import sqlite3
import uvicorn
import numpy as np
import threading
import subprocess
import configparser
import queue
from datetime import datetime
from collections import deque
from typing import Dict, Any, Optional, List
from pydantic import BaseModel
from fastapi import FastAPI, File, UploadFile, HTTPException, Depends
from fastapi.responses import JSONResponse, HTMLResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO
from PIL import Image
import sys
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler("backend.log"),
        logging.StreamHandler(sys.__stdout__)
    ]
)

class StreamToLogger:
    def __init__(self, logger, log_level):
        self.logger = logger
        self.log_level = log_level

    def write(self, buf):
        for line in buf.rstrip().splitlines():
            self.logger.log(self.log_level, line.rstrip())

    def flush(self):
        pass

    def isatty(self):
        return False

sys.stdout = StreamToLogger(logging.getLogger('STDOUT'), logging.INFO)
sys.stderr = StreamToLogger(logging.getLogger('STDERR'), logging.ERROR)

# Initialize FastAPI
app = FastAPI(title="SmartCare - Risk-Based Proactive Monitoring (RBATPM)")

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------------
# === LOAD CONFIG FROM config.ini ===
# ------------------------------------------------------------------
CONFIG_FILE = os.path.join(os.path.dirname(__file__), "config.ini")

def load_config() -> configparser.ConfigParser:
    cfg = configparser.ConfigParser(inline_comment_prefixes=("#",), interpolation=None)
    cfg.read_dict({
        "server":      {"host": "0.0.0.0", "port": "5000", "workers": "1", "log_level": "info"},
        "model":       {"model_path": "yolo26l.pt", "img_size": "1280", "conf_thresh": "0.25",
                        "device": "0", "inference_sample_fps": "5"},
        "database":    {"db_path": "rbatpm.db"},
        "storage":     {"clips_dir": "clips", "recordings_dir": "clips/recordings",
                        "inferred_clips_dir": "clips/inferred",
                        "images_dir": "uploaded_images", "clips_retention_days": "30",
                        "janitor_interval_sec": "3600"},
        "recording":   {"default_pre_buffer_sec": "5", "default_post_buffer_sec": "5",
                        "max_recording_duration_sec": "600",
                        "frame_buffer_duration_sec": "30",
                        "max_frame_width": "1280", "max_frame_height": "720"},
        "risk_rules":  {"high_amount_threshold": "5000", "medium_amount_threshold": "2000",
                        "medium_action_types": "Refund, Discount Override"},
        "inference":   {"presence_threshold_pct": "30.0"},
        "demo":        {"demo_high_threshold": "", "demo_medium_threshold": "",
                        "demo_presence_pct": "", "demo_offline_mode": "false"},
    })
    if os.path.exists(CONFIG_FILE):
        cfg.read(CONFIG_FILE)
        print(f"[+] Config loaded from {CONFIG_FILE}")
    else:
        print(f"[!] config.ini not found — using built-in defaults")
    return cfg

cfg = load_config()

# ------------------------------------------------------------------
# === CONFIGURATION (resolved from config.ini) ===
# ------------------------------------------------------------------
MODEL_PATH   = cfg.get("model",    "model_path")
IMG_SIZE     = cfg.getint("model", "img_size")
CONF_THRESH  = cfg.getfloat("model", "conf_thresh")
DEVICE       = cfg.get("model",    "device")   # kept as str so "cpu" also works
INFERENCE_FPS = cfg.getint("model", "inference_sample_fps")

DB_PATH      = cfg.get("database", "db_path")
CLIPS_DIR    = cfg.get("storage",  "clips_dir")
INFERRED_CLIPS_DIR = cfg.get("storage", "inferred_clips_dir", fallback="clips/inferred")
BASE_SAVE_DIR = cfg.get("storage", "images_dir")
CLIPS_RETENTION_DAYS = cfg.getint("storage", "clips_retention_days")
JANITOR_INTERVAL = cfg.getint("storage", "janitor_interval_sec")

MAX_FRAME_W  = cfg.getint("recording", "max_frame_width")
MAX_FRAME_H  = cfg.getint("recording", "max_frame_height")
DEBUG_MAX_W  = cfg.getint("recording", "debug_max_width", fallback=1280)
DEBUG_MAX_H  = cfg.getint("recording", "debug_max_height", fallback=720)
FRAME_BUFFER_DUR = cfg.getint("recording", "frame_buffer_duration_sec")
DEFAULT_PRE_BUFFER_SEC  = cfg.getint("recording", "default_pre_buffer_sec", fallback=5)
DEFAULT_POST_BUFFER_SEC = cfg.getint("recording", "default_post_buffer_sec", fallback=5)
MAX_RECORDING_SEC       = cfg.getint("recording", "max_recording_duration_sec", fallback=600)

# Risk rule thresholds (allow [demo] overrides)
_high_thr = cfg.get("demo", "demo_high_threshold").strip()
_med_thr  = cfg.get("demo", "demo_medium_threshold").strip()
RISK_HIGH_THRESHOLD   = float(_high_thr) if _high_thr else cfg.getfloat("risk_rules", "high_amount_threshold")
RISK_MEDIUM_THRESHOLD = float(_med_thr)  if _med_thr  else cfg.getfloat("risk_rules", "medium_amount_threshold")
MEDIUM_ACTION_TYPES   = [a.strip() for a in cfg.get("risk_rules", "medium_action_types").split(",")]

# Inference presence threshold (allow [demo] override)
_pres = cfg.get("demo", "demo_presence_pct").strip()
PRESENCE_THRESHOLD_PCT = float(_pres) if _pres else cfg.getfloat("inference", "presence_threshold_pct")
GENERATE_INFERRED_VIDEO = cfg.getboolean("inference", "generate_inferred_video", fallback=True)

DEMO_OFFLINE_MODE = cfg.getboolean("demo", "demo_offline_mode")

# MediaMTX WebRTC config
MEDIAMTX_HOST_IP = cfg.get("mediamtx", "host_ip", fallback="100.94.110.18")
MEDIAMTX_WEBRTC_PORT = cfg.get("mediamtx", "webrtc_port", fallback="8889")

# Build camera_id -> WebRTC stream name mapping from config.ini
CAMERA_WEBRTC_MAP = {}
cam_idx = 1
while True:
    cam_id = cfg.get("cameras", f"cam{cam_idx}_id", fallback=None)
    stream_name = cfg.get("mediamtx", f"cam{cam_idx}_stream", fallback=None)
    if not cam_id or not stream_name:
        break
    CAMERA_WEBRTC_MAP[cam_id] = stream_name
    cam_idx += 1

os.makedirs(BASE_SAVE_DIR, exist_ok=True)
os.makedirs(CLIPS_DIR, exist_ok=True)
os.makedirs(INFERRED_CLIPS_DIR, exist_ok=True)
os.makedirs(cfg.get("storage", "recordings_dir"), exist_ok=True)

print("\n" + "="*60)
print("  SmartCare RBATPM — Resolved Configuration")
print("="*60)
print(f"  Model          : {MODEL_PATH}")
print(f"  YOLO Conf      : {CONF_THRESH}  |  Device: {DEVICE}  |  Infer FPS: {INFERENCE_FPS}")
print(f"  DB             : {DB_PATH}")
print(f"  Clips Dir      : {CLIPS_DIR}  (retention: {CLIPS_RETENTION_DAYS}d)")
print(f"  Inferred Dir   : {INFERRED_CLIPS_DIR}")
print(f"  Gen Inf Video  : {GENERATE_INFERRED_VIDEO}  |  Debug Res: {DEBUG_MAX_W}x{DEBUG_MAX_H}")
print(f"  Risk Thresholds: High >₹{RISK_HIGH_THRESHOLD:.0f}  |  Medium >₹{RISK_MEDIUM_THRESHOLD:.0f}")
print(f"  Medium Actions : {', '.join(MEDIUM_ACTION_TYPES)}")
print(f"  Presence Thr   : {PRESENCE_THRESHOLD_PCT}%")
print(f"  Demo Offline   : {DEMO_OFFLINE_MODE}")
print("="*60 + "\n")


# ------------------------------------------------------------------
# Load model once at startup + warm-up
# ------------------------------------------------------------------
assert torch.cuda.is_available(), "CUDA NOT AVAILABLE – check --gpus all"
print(f"CUDA device: {torch.cuda.get_device_name(int(DEVICE) if DEVICE.isdigit() else DEVICE)}")

model = YOLO(MODEL_PATH, task="detect")

# Warm-up
dummy = np.zeros((640, 640, 3), dtype=np.uint8)
_ = model(dummy, imgsz=640, device=DEVICE, verbose=False)
print("Model loaded & warmed-up on GPU. Classes:", model.names)

# Dynamic class mapping for person
PERSON_CLASS_IDX = 0
for idx, name in model.names.items():
    if name.lower() == 'person':
        PERSON_CLASS_IDX = idx
        break
print(f"Detected 'person' class index: {PERSON_CLASS_IDX}")

# ------------------------------------------------------------------
# === DATABASE SETUP ===
# ------------------------------------------------------------------
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Create counters table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS counters (
        counter_id TEXT PRIMARY KEY,
        camera_id TEXT,
        health TEXT,
        subscription INTEGER
    )
    """)
    
    # Create alerts table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT,
        staff_id TEXT,
        counter_id TEXT,
        module TEXT,
        action_type TEXT,
        amount REAL,
        timestamp TEXT,
        risk_score TEXT,
        clip_id TEXT,
        clip_url TEXT,
        inferred_clip_url TEXT,
        recording_status TEXT,
        camera_health TEXT,
        person_present INTEGER,
        person_count INTEGER,
        presence_duration_sec REAL,
        clip_duration_sec REAL,
        flag TEXT,
        reviewer_remarks TEXT,
        reviewer_status TEXT,
        reviewer_time TEXT,
        audit_logs TEXT
    )
    """)
    
    # Check for schema migration (add inferred_clip_url if missing)
    cursor.execute("PRAGMA table_info(alerts)")
    existing_columns = [col[1] for col in cursor.fetchall()]
    if "inferred_clip_url" not in existing_columns:
        cursor.execute("ALTER TABLE alerts ADD COLUMN inferred_clip_url TEXT")
        print("[+] Migrated database schema: Added 'inferred_clip_url' column to alerts table.")
    
    # Create ROI configs table for per-camera region of interest polygons
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS roi_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id TEXT NOT NULL,
        roi_name TEXT NOT NULL,
        coords TEXT NOT NULL,
        config_width INTEGER DEFAULT 1280,
        config_height INTEGER DEFAULT 720,
        UNIQUE(camera_id, roi_name)
    )
    """)
    
    # Seed default counters
    cursor.execute("SELECT COUNT(*) FROM counters")
    if cursor.fetchone()[0] == 0:
        default_counters = [
            ("Billing Desk 1", "CAM01", "Online", 1),
            ("Cash Counter 2", "CAM02", "Online", 1),
            ("Pharmacy Counter 1", "CAM03", "Online", 1),
            ("Inventory Counter", "CAM04", "Online", 0)
        ]
        cursor.executemany("INSERT INTO counters VALUES (?, ?, ?, ?)", default_counters)
        
    # Force CAM03 to Online in case it was previously offline
    cursor.execute("UPDATE counters SET health='Online' WHERE camera_id='CAM03'")
    # Force CAM04 to Offline to hide mock video from UI
    cursor.execute("UPDATE counters SET health='Offline' WHERE camera_id='CAM04'")
    
    conn.commit()
    conn.close()

init_db()

# Global tracking of active recording sessions
# transaction_id -> {stream, clip_id, alert_db_id, counter_id}
active_recordings = {}

# ------------------------------------------------------------------
# === CAMERA STREAMING & RECORDING ENGINE ===
# ------------------------------------------------------------------
class CameraStream:
    def __init__(self, camera_id: str, stream_url: str, is_rtsp: bool = False, fps: int = 10, buffer_duration_sec: int = 15):
        self.camera_id = camera_id
        self.stream_url = stream_url
        self.is_rtsp = is_rtsp
        self.fps = fps
        self.frame_delay = 1.0 / fps
        self.max_buffer_size = fps * buffer_duration_sec
        self.frame_buffer = deque(maxlen=self.max_buffer_size)
        
        self.latest_raw_frame = None
        self.latest_frame_ts = 0.0
        
        self.running = False
        self.thread = None
        
        # Recording status
        self.is_recording = False
        self.clip_id = None
        self.writer = None
        self.recording_path = None
        self.frames_to_write_after_stop = 0
        self.recording_meta = {}
        
        self.lock = threading.Lock()
        self.health_status = "Online"
        
    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.thread.start()
        print(f"[+] Started stream loop for {self.camera_id} (Source: {self.stream_url})")

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join()
        with self.lock:
            if self.writer:
                self.writer.release()
                self.writer = None
        print(f"[-] Stopped stream loop for {self.camera_id}")

    def _process_single_frame(self, frame, timestamp):
        with self.lock:
            # Resize large frames to save memory and CPU
            h, w = frame.shape[:2]
            if w > MAX_FRAME_W or h > MAX_FRAME_H:
                frame = cv2.resize(frame, (MAX_FRAME_W, MAX_FRAME_H))
            
            self.frame_buffer.append((timestamp, frame.copy()))
            
            # Write to active recording
            if self.is_recording and self.writer:
                if self.frames_to_write_after_stop > 0:
                    if hasattr(self, 'post_buffer_deadline') and time.time() > self.post_buffer_deadline:
                        print(f"[!] Post-buffer deadline reached for clip {self.clip_id}. Force finalizing recording.")
                        self._finalize_recording_async()
                    else:
                        self.writer.write(frame)
                        self.frames_to_write_after_stop -= 1
                        if self.frames_to_write_after_stop == 0:
                            self._finalize_recording_async()
                else:
                    self.writer.write(frame)

    def _capture_loop(self):
        while self.running:
            if self.is_rtsp:
                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay|max_delay;500000"
            else:
                os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
            
            cap = cv2.VideoCapture(self.stream_url)
            os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
            
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            
            if not cap.isOpened():
                print(f"[-] Camera {self.camera_id} failed to connect to {self.stream_url}")
                self.health_status = "Offline"
                self._update_db_health("Offline")
                time.sleep(2.0)
                continue
                
            self.health_status = "Online"
            self._update_db_health("Online")
            
            source_fps = cap.get(cv2.CAP_PROP_FPS)
            if source_fps <= 0:
                source_fps = 30.0
                
            frame_skip = max(1, int(round(source_fps / self.fps)))
            
            if not self.is_rtsp:
                # Video file loop for offline testing
                while self.running and cap.isOpened():
                    start_time = time.time()
                    ret = False
                    frame = None
                    for _ in range(frame_skip):
                        ret, frame = cap.read()
                        if not ret:
                            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                            ret, frame = cap.read()
                            if not ret:
                                break
                    if not ret or frame is None:
                        time.sleep(0.5)
                        continue
                    
                    timestamp = time.time()
                    self._process_single_frame(frame, timestamp)
                    
                    elapsed = time.time() - start_time
                    sleep_time = max(0.001, self.frame_delay - elapsed)
                    time.sleep(sleep_time)
                cap.release()
            else:
                # Dedicated background reader thread for RTSP live stream to flush OpenCV socket buffer continuously
                reader_active = [True]
                
                def rtsp_reader():
                    while self.running and reader_active[0] and cap.isOpened():
                        ret, raw_f = cap.read()
                        if ret and raw_f is not None:
                            now = time.time()
                            with self.lock:
                                self.latest_raw_frame = raw_f
                                self.latest_frame_ts = now
                        else:
                            time.sleep(0.005)

                r_thread = threading.Thread(target=rtsp_reader, daemon=True)
                r_thread.start()
                
                last_ts_processed = 0.0
                
                while self.running and cap.isOpened():
                    start_time = time.time()
                    
                    with self.lock:
                        raw_f = self.latest_raw_frame
                        f_ts = self.latest_frame_ts
                    
                    # Detect stream disconnect/stall (> 4.0s without a new frame)
                    if start_time - f_ts > 4.0 and f_ts > 0:
                        print(f"[-] RTSP stream {self.camera_id} stalled/disconnected. Reconnecting...")
                        self.health_status = "Offline"
                        self._update_db_health("Offline")
                        if self.is_recording:
                            print(f"[!] Stream disconnected during active recording. Force finalizing clip {getattr(self, 'clip_id', '')}")
                            self._finalize_recording_async()
                        reader_active[0] = False
                        r_thread.join(timeout=1.0)
                        cap.release()
                        break
                        
                    if raw_f is not None and f_ts > last_ts_processed:
                        last_ts_processed = f_ts
                        self._process_single_frame(raw_f.copy(), f_ts)
                        
                    elapsed = time.time() - start_time
                    sleep_time = max(0.001, self.frame_delay - elapsed)
                    time.sleep(sleep_time)
                    
                reader_active[0] = False
                if cap.isOpened():
                    cap.release()
                time.sleep(1.0)

    def start_recording(self, clip_id: str, pre_buffer_sec: int, post_buffer_sec: int, meta: dict):
        with self.lock:
            if self.is_recording:
                print(f"[!] Stream {self.camera_id} already recording. Finalizing previous recording before starting clip {clip_id}.")
                if self.writer:
                    self.writer.release()
                    self.writer = None
                self.is_recording = False
                if hasattr(self, 'clip_id') and hasattr(self, 'recording_meta'):
                    enqueue_clip_for_processing(self.clip_id, self.recording_path, self.recording_meta)
            
            self.clip_id = clip_id
            self.recording_meta = meta
            self.recording_meta["pre_buffer_sec"] = pre_buffer_sec
            self.recording_meta["post_buffer_sec"] = post_buffer_sec
            
            self.recording_path = os.path.join(CLIPS_DIR, f"{clip_id}.mp4")
            
            if len(self.frame_buffer) > 0:
                _, sample_frame = self.frame_buffer[-1]
            else:
                sample_frame = np.zeros((720, 1280, 3), dtype=np.uint8)
                
            height, width = sample_frame.shape[:2]
            fourcc = cv2.VideoWriter_fourcc(*'mp4v')
            self.writer = cv2.VideoWriter(self.recording_path, fourcc, self.fps, (width, height))
            
            # Write pre-buffered frames
            now = time.time()
            pre_buffer_frames = []
            for ts, frame in self.frame_buffer:
                if now - ts <= pre_buffer_sec:
                    pre_buffer_frames.append(frame)
            
            print(f"[+] Writing {len(pre_buffer_frames)} pre-buffered frames for {clip_id}")
            for frame in pre_buffer_frames:
                self.writer.write(frame)
                
            self.is_recording = True
            self.frames_to_write_after_stop = 0

    def stop_recording(self):
        with self.lock:
            if not self.is_recording:
                return {"status": "failed", "reason": "not_recording"}
                
            post_buffer_sec = self.recording_meta.get("post_buffer_sec", 0)
            post_frames = post_buffer_sec * self.fps
            
            if post_frames > 0:
                self.frames_to_write_after_stop = post_frames
                self.post_buffer_deadline = time.time() + (post_buffer_sec + 3.0)
                return {"status": "processing", "clip_id": self.clip_id, "delayed": True}
            else:
                path, clip_id, meta = self.recording_path, self.clip_id, self.recording_meta
                self.is_recording = False
                if self.writer:
                    self.writer.release()
                    self.writer = None
                return {"status": "ready", "clip_id": clip_id, "path": path, "meta": meta}

    def _finalize_recording_async(self):
        path, clip_id, meta = self.recording_path, self.clip_id, self.recording_meta
        self.is_recording = False
        if self.writer:
            self.writer.release()
            self.writer = None
            
        print(f"[+] Finished capturing post-buffer. Enqueuing clip {clip_id} for inference queue")
        enqueue_clip_for_processing(clip_id, path, meta)

    def _update_db_health(self, status):
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute("UPDATE counters SET health = ? WHERE camera_id = ?", (status, self.camera_id))
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"Error updating health in db: {e}")

    def get_latest_frame(self):
        with self.lock:
            if len(self.frame_buffer) > 0:
                return self.frame_buffer[-1][1].copy()
            return None

class RecorderManager:
    def __init__(self):
        self.streams: Dict[str, CameraStream] = {}
        
    def register_camera(self, camera_id: str, stream_url: str, is_rtsp: bool = False, fps: int = 10, buffer_duration_sec: int = 15):
        self.streams[camera_id] = CameraStream(camera_id, stream_url, is_rtsp, fps, buffer_duration_sec)
        self.streams[camera_id].start()
        
    def shutdown(self):
        for stream in self.streams.values():
            stream.stop()

# Instantiate global recorder manager
recorder_manager = RecorderManager()

# ------------------------------------------------------------------
# === ROI UTILITY FUNCTIONS ===
# ------------------------------------------------------------------
def point_in_polygon(px: float, py: float, polygon: list) -> bool:
    """Ray-casting algorithm: check if point (px, py) is inside polygon.
    polygon is a flat list [x1, y1, x2, y2, ...]"""
    n = len(polygon) // 2
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i * 2], polygon[i * 2 + 1]
        xj, yj = polygon[j * 2], polygon[j * 2 + 1]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def get_rois_for_camera(camera_id: str) -> list:
    """Fetch all ROI configs for a camera from the database.
    If no ROI is configured, return a default central counter ROI zone."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM roi_configs WHERE camera_id = ?", (camera_id,))
    rows = cursor.fetchall()
    conn.close()
    rois = []
    for row in rows:
        coords = [int(c) for c in row["coords"].split(";") if c.strip()]
        rois.append({
            "name": row["roi_name"],
            "coords": coords,
            "config_width": row["config_width"],
            "config_height": row["config_height"]
        })
    
    # Fallback: Default central counter ROI zone if no custom ROI is saved
    if not rois:
        rois.append({
            "name": "Counter Zone (Default)",
            "coords": [300, 180, 976, 180, 976, 677, 300, 677],
            "config_width": 1280,
            "config_height": 720
        })
    return rois

def is_detection_in_any_roi(box, frame_width: int, frame_height: int, rois: list) -> bool:
    """Check if the center of a detection bounding box falls inside any configured ROI.
    Coordinates are scaled from frame dimensions to ROI config dimensions."""
    x1, y1, x2, y2 = box.xyxy[0].tolist()
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    for roi in rois:
        # Scale detection center from frame coords to ROI config coords
        scale_x = roi["config_width"] / frame_width
        scale_y = roi["config_height"] / frame_height
        scaled_cx = cx * scale_x
        scaled_cy = cy * scale_y
        if point_in_polygon(scaled_cx, scaled_cy, roi["coords"]):
            return True
    return False

# ------------------------------------------------------------------
# === INFERENCE SEQUENTIAL QUEUE & WORKER ===
# ------------------------------------------------------------------
inference_queue = queue.Queue()

def enqueue_clip_for_processing(clip_id: str, path: str, meta: dict):
    qsize = inference_queue.qsize() + 1
    add_audit_log(meta["alert_db_id"], f"Clip enqueued for sequential inference worker (Queue position: #{qsize}).")
    print(f"[+] Enqueued clip {clip_id} for sequential inference worker (Queue size: {qsize}).")
    inference_queue.put((clip_id, path, meta))

def inference_worker_loop():
    print("[+] Sequential GPU Inference Worker Thread initialized & waiting for jobs.")
    while True:
        try:
            item = inference_queue.get()
            if item is None:
                break
            clip_id, path, meta = item
            print(f"[+] Inference Worker starting processing on clip {clip_id} (Remaining in queue: {inference_queue.qsize()})")
            process_clip_background(clip_id, path, meta)
            inference_queue.task_done()
        except Exception as e:
            print(f"[!] Error in inference_worker_loop: {e}")
            time.sleep(0.5)

# ------------------------------------------------------------------
# === INFERENCE & TRANSCODE PIPELINE ===
# ------------------------------------------------------------------
def process_clip_background(clip_id: str, path: str, meta: dict):
    # Ensure RTSP capture env vars are cleared when reading local video files
    os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
    
    # Step 1: Add audit log event
    add_audit_log(meta["alert_db_id"], "Recording finished. Starting H.264 transcoding.")
    
    # Step 2: Transcode MP4 using ffmpeg to ensure compatibility with HTML5 browser video players
    h264_path = path.replace(".mp4", "_h264.mp4")
    transcoded = False
    try:
        cmd = [
            "ffmpeg", "-y", "-i", path,
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-profile:v", "baseline", "-level", "3.0",
            h264_path
        ]
        # Run subprocess silently
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        if os.path.exists(h264_path) and os.path.getsize(h264_path) > 0:
            os.replace(h264_path, path)
            transcoded = True
            add_audit_log(meta["alert_db_id"], "Transcoding completed. Starting YOLOv8 inference.")
    except Exception as e:
        print(f"[-] Failed to transcode video to H.264: {e}")
        if os.path.exists(h264_path):
            try: os.remove(h264_path)
            except: pass
        add_audit_log(meta["alert_db_id"], f"Transcoding failed (fallback to raw mp4v): {e}")

    # Step 3: Resolve camera_id for this alert to load ROI configs
    camera_id = None
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT camera_id FROM counters WHERE counter_id = (SELECT counter_id FROM alerts WHERE id = ?)", (meta["alert_db_id"],))
        row = cursor.fetchone()
        if row:
            camera_id = row["camera_id"]
        conn.close()
    except Exception as e:
        print(f"[-] Failed to resolve camera_id for alert {meta['alert_db_id']}: {e}")

    # Load ROI configs for this camera
    rois = []
    use_roi = False
    if camera_id:
        rois = get_rois_for_camera(camera_id)
        if rois:
            use_roi = True
            roi_names = ", ".join([r["name"] for r in rois])
            add_audit_log(meta["alert_db_id"], f"ROI mode: Checking person presence within ROI(s): [{roi_names}] for {camera_id}.")
        else:
            add_audit_log(meta["alert_db_id"], f"No ROI configured for {camera_id}. Using full-frame detection.")
    
    # Step 4: Run YOLO inference on sampled frames
    msg_gen = f" & rendering downscaled ({DEBUG_MAX_W}x{DEBUG_MAX_H}) inferred clip" if GENERATE_INFERRED_VIDEO else " (debug video rendering disabled)"
    add_audit_log(meta["alert_db_id"], f"Analyzing video frames with GPU model{msg_gen}.")
    
    os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print(f"[-] Cannot open video for inference: {path}")
        update_db_alert_status(meta["alert_db_id"], {
            "recording_status": "Failed",
            "flag": "monitoring_gap"
        })
        add_audit_log(meta["alert_db_id"], "Error: Cannot open video clip for YOLO analysis.")
        return

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if fps <= 0 or np.isnan(fps): fps = 10.0
    clip_duration = total_frames / fps if total_frames > 0 else 0.0

    # Sample at configured inference FPS
    sample_step = max(1, int(round(fps / float(INFERENCE_FPS))))
    frame_idx = 0
    sampled_frames_count = 0
    frames_with_person = 0
    max_persons = 0

    inferred_raw_path = os.path.join(INFERRED_CLIPS_DIR, f"{clip_id}_inferred_raw.mp4")
    inferred_final_path = os.path.join(INFERRED_CLIPS_DIR, f"{clip_id}_inferred.mp4")
    out_writer = None
    last_boxes = None
    render_w, render_h = 0, 0
    
    try:
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret or frame is None:
                break
                
            frame_h, frame_w = frame.shape[:2]
            
            # Determine downscaled resolution for debug video rendering if enabled
            if GENERATE_INFERRED_VIDEO and out_writer is None:
                if frame_w > DEBUG_MAX_W or frame_h > DEBUG_MAX_H:
                    scale = min(DEBUG_MAX_W / float(frame_w), DEBUG_MAX_H / float(frame_h))
                    render_w = int(frame_w * scale)
                    render_h = int(frame_h * scale)
                else:
                    render_w, render_h = frame_w, frame_h
                
                # Ensure even dimensions for ffmpeg libx264 encoding compatibility
                render_w = (render_w // 2) * 2
                render_h = (render_h // 2) * 2
                    
                fourcc = cv2.VideoWriter_fourcc(*'mp4v')
                out_writer = cv2.VideoWriter(inferred_raw_path, fourcc, fps, (render_w, render_h))
                if not out_writer.isOpened():
                    print(f"[-] Failed to initialize VideoWriter for {inferred_raw_path}")

            if frame_idx % sample_step == 0:
                sampled_frames_count += 1
                # Run prediction on GPU using persistent warm model
                with torch.no_grad():
                    results = model.predict(frame, classes=[PERSON_CLASS_IDX], conf=CONF_THRESH, device=DEVICE, verbose=False)
                
                if len(results) > 0 and len(results[0].boxes) > 0:
                    last_boxes = results[0].boxes
                    if use_roi:
                        # ROI-filtered: count only detections whose center falls inside an ROI
                        roi_count = 0
                        for box in last_boxes:
                            if is_detection_in_any_roi(box, frame_w, frame_h, rois):
                                roi_count += 1
                        if roi_count > 0:
                            frames_with_person += 1
                            if roi_count > max_persons:
                                max_persons = roi_count
                    else:
                        # Full-frame detection
                        count = len(last_boxes)
                        if count > 0:
                            frames_with_person += 1
                            if count > max_persons:
                                max_persons = count
                else:
                    last_boxes = None

            # Only draw and encode debug overlays if GENERATE_INFERRED_VIDEO is True
            if GENERATE_INFERRED_VIDEO and out_writer is not None and out_writer.isOpened():
                # Resize frame to downscaled render resolution if needed
                if (render_w, render_h) != (frame_w, frame_h):
                    annotated_frame = cv2.resize(frame, (render_w, render_h))
                else:
                    annotated_frame = frame.copy()

                # 0. Top Header Status Bar
                overlay_bar = annotated_frame.copy()
                cv2.rectangle(overlay_bar, (0, 0), (render_w, 40), (20, 20, 20), -1)
                cv2.addWeighted(overlay_bar, 0.6, annotated_frame, 0.4, 0, annotated_frame)
                
                roi_names_str = ", ".join([r["name"] for r in rois]) if rois else "None"
                header_text = f"AI INFERRED STREAM  |  ACTIVE ROI: {roi_names_str}"
                cv2.putText(annotated_frame, header_text, (15, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)

                # 1. Render ROI polygon(s) if configured
                if rois:
                    for roi in rois:
                        coords = roi["coords"]
                        config_w = roi.get("config_width", 1280)
                        config_h = roi.get("config_height", 720)
                        
                        pts = []
                        for i in range(0, len(coords), 2):
                            px = int(coords[i] * (render_w / config_w))
                            py = int(coords[i+1] * (render_h / config_h))
                            pts.append([px, py])
                        
                        if len(pts) >= 3:
                            pts_np = np.array(pts, np.int32).reshape((-1, 1, 2))
                            # Translucent polygon fill
                            overlay = annotated_frame.copy()
                            cv2.fillPoly(overlay, [pts_np], (255, 200, 0)) # BGR Cyan-Amber fill
                            cv2.addWeighted(overlay, 0.25, annotated_frame, 0.75, 0, annotated_frame)
                            # Polygon border line
                            cv2.polylines(annotated_frame, [pts_np], isClosed=True, color=(255, 255, 0), thickness=2)
                            # Polygon vertex points
                            for pt in pts:
                                cv2.circle(annotated_frame, (pt[0], pt[1]), 4, (0, 255, 255), -1)
                            # ROI label badge tag
                            roi_name = roi.get("name", "ROI")
                            lx, ly = max(10, pts[0][0]), max(50, pts[0][1] - 10)
                            (lw, lh), _ = cv2.getTextSize(f"ROI: {roi_name}", cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
                            cv2.rectangle(annotated_frame, (lx - 4, ly - lh - 4), (lx + lw + 8, ly + 6), (255, 255, 0), -1)
                            cv2.putText(annotated_frame, f"ROI: {roi_name}", (lx, ly),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)

                # 2. Render Person Bounding Boxes & Detection Center Point
                if last_boxes is not None:
                    scale_box_x = render_w / float(frame_w)
                    scale_box_y = render_h / float(frame_h)
                    for box in last_boxes:
                        b_x1_raw, b_y1_raw, b_x2_raw, b_y2_raw = map(float, box.xyxy[0].tolist())
                        b_x1 = int(b_x1_raw * scale_box_x)
                        b_y1 = int(b_y1_raw * scale_box_y)
                        b_x2 = int(b_x2_raw * scale_box_x)
                        b_y2 = int(b_y2_raw * scale_box_y)
                        conf = float(box.conf[0].item())
                        in_roi = is_detection_in_any_roi(box, frame_w, frame_h, rois) if use_roi else False
                        
                        box_color = (0, 255, 0) if (not use_roi or in_roi) else (0, 215, 255)
                        roi_badge = " [IN ROI]" if (use_roi and in_roi) else (" [OUTSIDE ROI]" if use_roi else "")
                            
                        cv2.rectangle(annotated_frame, (b_x1, b_y1), (b_x2, b_y2), box_color, 2)

                        # Detection center point evaluated against ROI polygon
                        cx = int((b_x1 + b_x2) / 2.0)
                        cy = int((b_y1 + b_y2) / 2.0)
                        cv2.circle(annotated_frame, (cx, cy), 5, box_color, -1)
                        cv2.circle(annotated_frame, (cx, cy), 2, (0, 0, 0), -1)
                        
                        label_str = f"person {int(conf * 100)}%{roi_badge}"
                        (w, h), _ = cv2.getTextSize(label_str, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
                        
                        # Badge background & text
                        cv2.rectangle(annotated_frame, (b_x1, max(42, b_y1 - h - 8)), (b_x1 + w + 8, max(h + 42, b_y1)), box_color, -1)
                        cv2.putText(annotated_frame, label_str, (b_x1 + 4, max(h + 35, b_y1 - 4)),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1, cv2.LINE_AA)
                                    
                out_writer.write(annotated_frame)

            frame_idx += 1
    except Exception as e:
        print(f"[!] Error during inference processing loop: {e}")
        add_audit_log(meta["alert_db_id"], f"Warning: Exception during YOLO analysis: {e}")
    finally:
        cap.release()
        if out_writer is not None:
            out_writer.release()

    # Transcode inferred clip to H.264 for web playback if debug video generation enabled
    inferred_clip_url = f"/clips/{clip_id}.mp4"
    if GENERATE_INFERRED_VIDEO and os.path.exists(inferred_raw_path):
        try:
            cmd_inf = [
                "ffmpeg", "-y", "-i", inferred_raw_path,
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-profile:v", "baseline", "-level", "3.0",
                inferred_final_path
            ]
            subprocess.run(cmd_inf, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            if os.path.exists(inferred_raw_path):
                os.remove(inferred_raw_path)
            if os.path.exists(inferred_final_path):
                inferred_clip_url = f"/clips/inferred/{clip_id}_inferred.mp4"
                add_audit_log(meta["alert_db_id"], f"Generated downscaled H.264 AI-inferred clip ({render_w}x{render_h}) with ROI & bounding boxes.")
        except Exception as e:
            print(f"[-] Failed to transcode inferred clip to H.264: {e}")
            if os.path.exists(inferred_raw_path):
                try:
                    os.replace(inferred_raw_path, inferred_final_path)
                    if os.path.exists(inferred_final_path):
                        inferred_clip_url = f"/clips/inferred/{clip_id}_inferred.mp4"
                except: pass
    elif not GENERATE_INFERRED_VIDEO:
        # Fallback to raw recorded clip URL when debug video generation is disabled
        inferred_clip_url = f"/clips/{clip_id}.mp4"
        add_audit_log(meta["alert_db_id"], "Debug video rendering disabled in config — linked raw recorded clip.")

    # Calculate presence duration & flags
    person_present = False
    presence_duration = 0.0
    
    if sampled_frames_count > 0:
        presence_ratio = (frames_with_person / sampled_frames_count) * 100.0
        # If person is detected in >= PRESENCE_THRESHOLD_PCT of sampled frames
        if presence_ratio >= PRESENCE_THRESHOLD_PCT:
            person_present = True
            presence_duration = (frames_with_person / sampled_frames_count) * clip_duration

    # If person is not present, raise alert flag & set risk to High
    final_risk = meta["original_risk"]
    mode_label = "ROI" if use_roi else "Full-Frame"
    if not person_present:
        flag = "alert"
        final_risk = "High"
        add_audit_log(meta["alert_db_id"], f"YOLO ({mode_label}): No person detected at counter! Risk escalated to HIGH.")
    else:
        flag = "clean"
        add_audit_log(meta["alert_db_id"], f"YOLO ({mode_label}): Person detected (Max: {max_persons}). Counter active. Status: CLEAN.")

    # Update database alert details
    update_data = {
        "person_present": 1 if person_present else 0,
        "person_count": max_persons,
        "presence_duration_sec": round(presence_duration, 2),
        "clip_duration_sec": round(clip_duration, 2),
        "recording_status": "Ready",
        "inferred_clip_url": inferred_clip_url,
        "flag": flag,
        "risk_score": final_risk
    }
    update_db_alert_status(meta["alert_db_id"], update_data)
    add_audit_log(meta["alert_db_id"], "Audit analysis complete. Ready for reviewer triage.")

# ------------------------------------------------------------------
# === DATABASE CRUD HELPERS ===
# ------------------------------------------------------------------
def add_audit_log(alert_id: int, message: str):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT audit_logs FROM alerts WHERE id = ?", (alert_id,))
    row = cursor.fetchone()
    logs = json.loads(row[0]) if (row and row[0]) else []
    
    logs.append({
        "time": datetime.now().strftime("%H:%M:%S"),
        "msg": message
    })
    
    cursor.execute("UPDATE alerts SET audit_logs = ? WHERE id = ?", (json.dumps(logs), alert_id))
    conn.commit()
    conn.close()

def update_db_alert_status(alert_id: int, data: dict):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    set_clause = ", ".join([f"{k} = ?" for k in data.keys()])
    values = tuple(data[k] for k in data.keys()) + (alert_id,)
    cursor.execute(f"UPDATE alerts SET {set_clause} WHERE id = ?", values)
    conn.commit()
    conn.close()

# ------------------------------------------------------------------
# === APP STARTUP AND SHUTDOWN LIFECYCLE ===
# ------------------------------------------------------------------
@app.on_event("startup")
def startup_event():
    # Register cameras from config.ini [cameras] section
    cam_index = 1
    registered_cams = set()
    while True:
        cam_id  = cfg.get("cameras", f"cam{cam_index}_id",  fallback=None)
        cam_url = cfg.get("cameras", f"cam{cam_index}_url", fallback=None)
        cam_fps = cfg.getint("cameras", f"cam{cam_index}_fps", fallback=10)
        if not cam_id or not cam_url:
            break
        is_rtsp = cam_url.startswith("rtsp://")
        recorder_manager.register_camera(
            camera_id=cam_id,
            stream_url=cam_url,
            is_rtsp=is_rtsp,
            fps=cam_fps,
            buffer_duration_sec=FRAME_BUFFER_DUR
        )
        registered_cams.add(cam_id)
        cam_index += 1

    print(f"[+] Registered {cam_index - 1} camera(s) from config.ini")
    print("[+] API started and background camera streams initialized.")

    # Synchronize counter health status in DB for unregistered cameras
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT DISTINCT camera_id FROM counters")
        db_cams = [row[0] for row in cursor.fetchall()]
        for c_id in db_cams:
            if c_id not in registered_cams:
                cursor.execute("UPDATE counters SET health = 'Offline' WHERE camera_id = ?", (c_id,))
        conn.commit()
        conn.close()
        print("[+] Synchronized counter health status in DB for unregistered cameras.")
    except Exception as e:
        print(f"[-] Failed to sync counter health status: {e}")

    # Start sequential GPU inference worker thread
    worker_thread = threading.Thread(target=inference_worker_loop, daemon=True)
    worker_thread.start()
    print("[+] Sequential GPU Inference Worker Thread started.")

    # Cleanup stuck transactions from previous runs
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM alerts WHERE recording_status IN ('Recording', 'Processing')")
        conn.commit()
        conn.close()
        print("[+] Removed stuck transactions from previous run.")
    except Exception as e:
        print(f"[-] Failed to remove stuck transactions: {e}")

    # Start recording safety watchdog thread (configurable auto-timeout via config.ini)
    def recording_watchdog():
        """Background thread: auto-stops any recording session running longer than MAX_RECORDING_SEC."""
        while True:
            try:
                now = time.time()
                for txn_id, info in list(active_recordings.items()):
                    start_time = info.get("start_time", now)
                    if now - start_time >= MAX_RECORDING_SEC:
                        print(f"[!] Watchdog: Transaction {txn_id} on counter {info.get('counter_id')} exceeded {MAX_RECORDING_SEC}s auto-timeout. Auto-ending recording.")
                        alert_db_id = info.get("alert_db_id")
                        if alert_db_id:
                            add_audit_log(alert_db_id, f"Safety Watchdog: Recording auto-ended after {MAX_RECORDING_SEC}s maximum timeout.")
                        _end_transaction_recording(txn_id)
            except Exception as e:
                print(f"[!] Recording watchdog error: {e}")
            time.sleep(2)

    watchdog_thread = threading.Thread(target=recording_watchdog, daemon=True)
    watchdog_thread.start()
    print(f"[+] Recording safety watchdog started ({MAX_RECORDING_SEC}-second auto-timeout).")

    # Start clip janitor background thread
    def clip_janitor():
        """Background thread: scan CLIPS_DIR every JANITOR_INTERVAL and delete files older than CLIPS_RETENTION_DAYS."""
        while True:
            try:
                cutoff = time.time() - (CLIPS_RETENTION_DAYS * 86400)
                pattern = os.path.join(CLIPS_DIR, "**", "*.mp4")
                deleted = []
                for fpath in glob.glob(pattern, recursive=True):
                    try:
                        if os.path.getmtime(fpath) < cutoff:
                            os.remove(fpath)
                            deleted.append(fpath)
                    except Exception as e:
                        print(f"[!] Janitor: could not delete {fpath}: {e}")
                if deleted:
                    print(f"[+] Clip janitor removed {len(deleted)} clip(s) older than {CLIPS_RETENTION_DAYS} days.")
                    for p in deleted:
                        print(f"    🗑  {p}")
                else:
                    print(f"[✓] Clip janitor scan complete — no expired clips found.")
            except Exception as e:
                print(f"[!] Clip janitor error: {e}")
            time.sleep(JANITOR_INTERVAL)

    janitor_thread = threading.Thread(target=clip_janitor, daemon=True)
    janitor_thread.start()
    print(f"[+] Clip janitor started — auto-delete clips >{CLIPS_RETENTION_DAYS}d old, every {JANITOR_INTERVAL}s.")


@app.on_event("shutdown")
def shutdown_event():
    recorder_manager.shutdown()
    print("[-] API shutdown complete. Stopped all camera feeds.")

# Serve recorded video clips & AI-inferred clips statically
app.mount("/clips/inferred", StaticFiles(directory=INFERRED_CLIPS_DIR), name="inferred_clips")
app.mount("/clips", StaticFiles(directory=CLIPS_DIR), name="clips")

# ------------------------------------------------------------------
# === API SCHEMA DEFINITIONS ===
# ------------------------------------------------------------------
class TransactionPayload(BaseModel):
    staff_id: str
    counter_id: str
    module: str
    action_type: str
    subscription: str  # 'Y' or 'N'
    pre_buffer_sec: Optional[int] = None
    post_buffer_sec: Optional[int] = None

class DispositionPayload(BaseModel):
    remarks: str
    outcome: str

class SubscriptionPayload(BaseModel):
    active: bool

class RoiItem(BaseModel):
    name: str
    coords: List[int]

class RoiSavePayload(BaseModel):
    rois: List[RoiItem]
    config_width: int = 1280
    config_height: int = 720

# ------------------------------------------------------------------
# === API ENDPOINTS ===
# ------------------------------------------------------------------

# Serve UI
@app.get("/", response_class=HTMLResponse)
def read_index():
    try:
        with open("templates/index.html", "r") as f:
            return HTMLResponse(content=f.read(), status_code=200)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="index.html not found inside templates folder.")

# Get camera RTSP URL info for displaying in UI
@app.get("/api/v1/stream-url")
def get_stream_url(camera_id: str = "CAM01"):
    stream = recorder_manager.streams.get(camera_id)
    if stream:
        return {"url": stream.stream_url}
    return {"url": "Unknown"}

# Get WebRTC URL for a camera (used by investigation modal live stream)
@app.get("/api/v1/webrtc-url")
def get_webrtc_url(camera_id: str = "CAM01"):
    stream_name = CAMERA_WEBRTC_MAP.get(camera_id)
    if stream_name:
        return {
            "webrtc_url": f"http://{MEDIAMTX_HOST_IP}:{MEDIAMTX_WEBRTC_PORT}/{stream_name}/",
            "camera_id": camera_id,
            "stream_name": stream_name
        }
    return {"webrtc_url": None, "camera_id": camera_id, "stream_name": None}

# Fetch Counters
@app.get("/api/v1/counters")
def get_counters():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM counters")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

# Update subscription toggle
@app.post("/api/v1/counters/{counter_id}/subscription")
def update_subscription(counter_id: str, payload: SubscriptionPayload):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("UPDATE counters SET subscription = ? WHERE counter_id = ?", (1 if payload.active else 0, counter_id))
    conn.commit()
    conn.close()
    return {"status": "success"}

# Fetch Alerts
@app.get("/api/v1/alerts")
def get_alerts():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM alerts ORDER BY id DESC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

# Save Auditor Remarks and Verification Status
@app.post("/api/v1/alerts/{alert_id}/disposition")
def update_disposition(alert_id: int, payload: DispositionPayload):
    now = datetime.now().isoformat()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # SaveRemarks
    cursor.execute("""
        UPDATE alerts 
        SET reviewer_remarks = ?, reviewer_status = ?, reviewer_time = ? 
        WHERE id = ?
    """, (payload.remarks, payload.outcome, now, alert_id))
    
    conn.commit()
    conn.close()
    
    add_audit_log(alert_id, f"Auditor set disposition to {payload.outcome}. Case closed.")
    return {"status": "success"}

class TransactionEndPayload(BaseModel):
    transaction_id: str
    amount: float

# Start Transaction simulation
@app.post("/api/v1/transaction/start")
def start_transaction(payload: TransactionPayload):
    # Step 1: Calculate initial risk score based on action type
    risk = "Medium" if payload.action_type in MEDIUM_ACTION_TYPES else "Low"
        
    transaction_id = f"TXN_{uuid.uuid4().hex[:8].upper()}"
    timestamp = datetime.now().isoformat()
    
    # Initialize basic logs
    initial_logs = [
        {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"Transaction {transaction_id} initiated by {payload.staff_id}."},
        {"time": datetime.now().strftime("%H:%M:%S"), "msg": f"Rule Evaluation: Initial Risk Score = {risk} (Amount: Pending completion)."}
    ]
    
    # Query Counter Mapping
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM counters WHERE counter_id = ?", (payload.counter_id,))
    counter_row = cursor.fetchone()
    conn.close()
    
    camera_id = counter_row["camera_id"] if counter_row else "CAM_UNK"
    camera_health = counter_row["health"] if counter_row else "Online"
    
    # Step 2: Check Subscription
    subscription_active = payload.subscription == "Y"
    
    if not subscription_active:
        # Save low-risk logged transaction immediately, bypass recording
        initial_logs.append({"time": datetime.now().strftime("%H:%M:%S"), "msg": "Subscription = N. Video capture skipped."})
        alert_data = {
            "transaction_id": transaction_id,
            "staff_id": payload.staff_id,
            "counter_id": payload.counter_id,
            "module": payload.module,
            "action_type": payload.action_type,
            "amount": 0.0,
            "timestamp": timestamp,
            "risk_score": "Low",
            "clip_id": "",
            "clip_url": "",
            "recording_status": "Ready",
            "camera_health": camera_health,
            "person_present": 1,
            "person_count": 1,
            "flag": "clean",
            "reviewer_status": "Auto-Cleared",
            "audit_logs": json.dumps(initial_logs)
        }
        insert_alert(alert_data)
        return {"status": "logged_only", "transaction_id": transaction_id}

    # Step 3: Handle Offline camera
    if camera_health == "Offline":
        initial_logs.append({"time": datetime.now().strftime("%H:%M:%S"), "msg": "VAS Call failed: CAMERA_OFFLINE. Raising Monitoring Gap alert."})
        alert_data = {
            "transaction_id": transaction_id,
            "staff_id": payload.staff_id,
            "counter_id": payload.counter_id,
            "module": payload.module,
            "action_type": payload.action_type,
            "amount": 0.0,
            "timestamp": timestamp,
            "risk_score": "High", # Gap counts as high risk regardless of original score
            "clip_id": "",
            "clip_url": "",
            "recording_status": "Failed",
            "camera_health": "Offline",
            "person_present": 0,
            "person_count": 0,
            "flag": "monitoring_gap",
            "reviewer_status": "Pending",
            "audit_logs": json.dumps(initial_logs)
        }
        insert_alert(alert_data)
        return {"status": "monitoring_gap", "transaction_id": transaction_id}

    # Step 4: Trigger active recording
    stream = recorder_manager.streams.get(camera_id)
    if not stream or stream.health_status == "Offline":
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute("UPDATE counters SET health = 'Offline' WHERE counter_id = ?", (payload.counter_id,))
            conn.commit()
            conn.close()
        except Exception:
            pass
        initial_logs.append({"time": datetime.now().strftime("%H:%M:%S"), "msg": f"VAS Stream {camera_id} Offline. Raising Monitoring Gap alert."})
        alert_data = {
            "transaction_id": transaction_id,
            "staff_id": payload.staff_id,
            "counter_id": payload.counter_id,
            "module": payload.module,
            "action_type": payload.action_type,
            "amount": 0.0,
            "timestamp": timestamp,
            "risk_score": "High",
            "clip_id": "",
            "clip_url": "",
            "recording_status": "Failed",
            "camera_health": "Offline",
            "person_present": 0,
            "person_count": 0,
            "flag": "monitoring_gap",
            "reviewer_status": "Pending",
            "audit_logs": json.dumps(initial_logs)
        }
        insert_alert(alert_data)
        return {"status": "monitoring_gap", "transaction_id": transaction_id}

    # Automatically stop any active recording running on this counter
    for active_txn_id, info in list(active_recordings.items()):
        if info["counter_id"] == payload.counter_id:
            print(f"[+] Autostopping active transaction {active_txn_id} to start {transaction_id}")
            _end_transaction_recording(active_txn_id)

    clip_id = f"clip_{uuid.uuid4().hex[:12]}"
    initial_logs.append({"time": datetime.now().strftime("%H:%M:%S"), "msg": f"VAS Triggered: Start recording (Clip ID: {clip_id})."})
    
    # Save pending alert details
    alert_data = {
        "transaction_id": transaction_id,
        "staff_id": payload.staff_id,
        "counter_id": payload.counter_id,
        "module": payload.module,
        "action_type": payload.action_type,
        "amount": 0.0,
        "timestamp": timestamp,
        "risk_score": risk,
        "clip_id": clip_id,
        "clip_url": f"/clips/{clip_id}.mp4",
        "recording_status": "Recording",
        "camera_health": "Online",
        "reviewer_status": "Pending",
        "audit_logs": json.dumps(initial_logs)
    }
    alert_db_id = insert_alert(alert_data)

    # Start camera recording with buffers
    meta = {
        "alert_db_id": alert_db_id,
        "transaction_id": transaction_id,
        "original_risk": risk,
        "camera_health": "Online"
    }
    
    pre_buf = payload.pre_buffer_sec if payload.pre_buffer_sec is not None else DEFAULT_PRE_BUFFER_SEC
    post_buf = payload.post_buffer_sec if payload.post_buffer_sec is not None else DEFAULT_POST_BUFFER_SEC
    stream.start_recording(clip_id, pre_buf, post_buf, meta)
    
    # Track active recording session
    active_recordings[transaction_id] = {
        "stream": stream,
        "clip_id": clip_id,
        "alert_db_id": alert_db_id,
        "counter_id": payload.counter_id,
        "start_time": time.time()
    }
    
    return {"status": "recording_started", "transaction_id": transaction_id, "clip_id": clip_id}

def _end_transaction_recording(transaction_id: str):
    active_info = active_recordings.get(transaction_id)
    if not active_info:
        return False
        
    stream = active_info["stream"]
    clip_id = active_info["clip_id"]
    alert_db_id = active_info["alert_db_id"]
    
    add_audit_log(alert_db_id, "Transaction ended. Finalizing video recording snippet.")
    res = stream.stop_recording()
    if res and res.get("status") == "ready":
        # Direct ready, trigger transcode and inference via sequential worker queue
        enqueue_clip_for_processing(clip_id, res["path"], res["meta"])
    elif res and res.get("status") == "processing":
        # _finalize_recording_async will handle running enqueue_clip_for_processing
        pass
        
    active_recordings.pop(transaction_id, None)
    return True

# End Transaction simulation
@app.post("/api/v1/transaction/end")
def end_transaction(payload: TransactionEndPayload):
    target_txn_id = payload.transaction_id
    active_info = active_recordings.get(target_txn_id)
    
    if not active_info and active_recordings:
        # Fallback to most recent active transaction ID if target_txn_id not in active_recordings
        target_txn_id = list(active_recordings.keys())[-1]
        print(f"[!] Stop requested for unknown transaction ID {payload.transaction_id}. Fallback to active: {target_txn_id}")
        active_info = active_recordings.get(target_txn_id)
        
    # Update amount and re-evaluate risk
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT id, action_type, risk_score FROM alerts WHERE transaction_id = ?", (target_txn_id,))
        row = cursor.fetchone()
        if row:
            alert_db_id = row["id"]
            action_type = row["action_type"]
            new_risk = "Low"
            if payload.amount > RISK_HIGH_THRESHOLD:
                new_risk = "High"
            elif payload.amount > RISK_MEDIUM_THRESHOLD or action_type in MEDIUM_ACTION_TYPES:
                new_risk = "Medium"
            
            cursor.execute("UPDATE alerts SET amount = ?, risk_score = ? WHERE id = ?", (payload.amount, new_risk, alert_db_id))
            conn.commit()
            
            # Update meta in active recording if present
            if active_info and hasattr(active_info["stream"], "recording_meta") and active_info["stream"].recording_meta:
                active_info["stream"].recording_meta["original_risk"] = new_risk
                
            add_audit_log(alert_db_id, f"Transaction completed with amount ₹{payload.amount}. Rule Risk re-evaluated to {new_risk}.")
        conn.close()
    except Exception as e:
        print(f"[-] Error updating amount on transaction end: {e}")

    success = _end_transaction_recording(target_txn_id)
    if not success:
        raise HTTPException(status_code=404, detail="No active transaction recording session found.")
        
    return {"status": "recording_stopped", "transaction_id": target_txn_id}

# Trigger Transaction simulation (Legacy wrapper)
@app.post("/api/v1/transaction")
def trigger_transaction(payload: TransactionPayload):
    res = start_transaction(payload)
    if res.get("status") == "recording_started":
        txn_id = res["transaction_id"]
        def finalize_after_3s():
            time.sleep(3.0)
            _end_transaction_recording(txn_id)
        threading.Thread(target=finalize_after_3s, daemon=True).start()
    return res

def insert_alert(alert_data):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    keys = alert_data.keys()
    columns = ", ".join(keys)
    placeholders = ", ".join(["?"] * len(keys))
    values = tuple(alert_data[k] for k in keys)
    cursor.execute(f"INSERT INTO alerts ({columns}) VALUES ({placeholders})", values)
    alert_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return alert_id

# ------------------------------------------------------------------
# MJPEG Streaming Endpoint for Real-time CCTV display
# ------------------------------------------------------------------
def generate_mjpeg_frames(camera_id: str):
    while True:
        # Read from specified camera
        stream = recorder_manager.streams.get(camera_id)
        frame = None
        if stream:
            frame = stream.get_latest_frame()
            
        if frame is not None:
            # Add text overlay to indicate live capture
            cv2.putText(frame, f"LIVE {camera_id} - RTSP PREVIEW", (30, 40), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2, cv2.LINE_AA)
            cv2.putText(frame, datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3], (30, 70), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
            
            # Encode frame to JPEG
            _, jpeg = cv2.imencode('.jpg', frame)
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + jpeg.tobytes() + b'\r\n\r\n')
        else:
            # Display offline message frame
            dummy_offline = np.zeros((480, 640, 3), dtype=np.uint8)
            cv2.putText(dummy_offline, f"{camera_id} OFFLINE / RECONNECTING...", (80, 240), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2, cv2.LINE_AA)
            _, jpeg = cv2.imencode('.jpg', dummy_offline)
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + jpeg.tobytes() + b'\r\n\r\n')
            
        time.sleep(0.1)

@app.get("/api/v1/live-stream")
def live_stream_mjpeg(camera_id: str = "CAM01"):
    return StreamingResponse(
        generate_mjpeg_frames(camera_id), 
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@app.get("/api/v1/latest-frame.jpg")
def get_latest_frame_jpeg(camera_id: str = "CAM01"):
    stream = recorder_manager.streams.get(camera_id)
    frame = None
    if stream:
        frame = stream.get_latest_frame()
        
    if frame is not None:
        # Add text overlay to indicate live capture
        cv2.putText(frame, f"LIVE {camera_id} - RTSP PREVIEW", (30, 40), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2, cv2.LINE_AA)
        cv2.putText(frame, datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3], (30, 70), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        
        # Encode frame to JPEG
        _, jpeg = cv2.imencode('.jpg', frame)
        return Response(content=jpeg.tobytes(), media_type="image/jpeg")
    else:
        # Display offline message frame
        dummy_offline = np.zeros((480, 640, 3), dtype=np.uint8)
        cv2.putText(dummy_offline, f"{camera_id} OFFLINE / RECONNECTING...", (80, 240), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2, cv2.LINE_AA)
        _, jpeg = cv2.imencode('.jpg', dummy_offline)
        return Response(content=jpeg.tobytes(), media_type="image/jpeg")


# ------------------------------------------------------------------
# === ROI CONFIGURATION API ENDPOINTS ===
# ------------------------------------------------------------------

@app.get("/api/v1/roi/{camera_id}")
def get_roi_configs(camera_id: str):
    """Fetch all ROI polygons for a given camera."""
    rois = get_rois_for_camera(camera_id)
    # Get config dimensions (use first ROI's dims or defaults)
    config_width = rois[0]["config_width"] if rois else 1280
    config_height = rois[0]["config_height"] if rois else 720
    return {
        "camera_id": camera_id,
        "config_width": config_width,
        "config_height": config_height,
        "rois": [{"name": r["name"], "coords": r["coords"]} for r in rois]
    }

@app.post("/api/v1/roi/{camera_id}")
def save_roi_configs(camera_id: str, payload: RoiSavePayload):
    """Save (overwrite) all ROI polygons for a given camera."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    # Delete existing ROIs for this camera
    cursor.execute("DELETE FROM roi_configs WHERE camera_id = ?", (camera_id,))
    # Insert new ones
    for roi in payload.rois:
        coords_str = ";".join(str(c) for c in roi.coords)
        cursor.execute(
            "INSERT INTO roi_configs (camera_id, roi_name, coords, config_width, config_height) VALUES (?, ?, ?, ?, ?)",
            (camera_id, roi.name, coords_str, payload.config_width, payload.config_height)
        )
    conn.commit()
    conn.close()
    print(f"[+] Saved {len(payload.rois)} ROI(s) for camera {camera_id}")
    return {"status": "success", "count": len(payload.rois)}

@app.delete("/api/v1/roi/{camera_id}/{roi_name}")
def delete_roi_config(camera_id: str, roi_name: str):
    """Delete a single ROI polygon by name for a camera."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM roi_configs WHERE camera_id = ? AND roi_name = ?", (camera_id, roi_name))
    deleted = cursor.rowcount
    conn.commit()
    conn.close()
    if deleted == 0:
        raise HTTPException(status_code=404, detail=f"ROI '{roi_name}' not found for camera {camera_id}")
    return {"status": "success"}

@app.get("/api/v1/roi-frame/{camera_id}")
def get_roi_reference_frame(camera_id: str):
    """Return a clean JPEG snapshot from the camera for ROI drawing canvas background."""
    stream = recorder_manager.streams.get(camera_id)
    frame = None
    if stream:
        frame = stream.get_latest_frame()
    if frame is not None:
        _, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        return Response(content=jpeg.tobytes(), media_type="image/jpeg")
    else:
        dummy = np.zeros((720, 1280, 3), dtype=np.uint8)
        cv2.putText(dummy, f"{camera_id} OFFLINE", (400, 360),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 255), 3, cv2.LINE_AA)
        _, jpeg = cv2.imencode('.jpg', dummy)
        return Response(content=jpeg.tobytes(), media_type="image/jpeg")

# ------------------------------------------------------------------
# === BACKWARD COMPATIBLE /upload-images ENDPOINT ===
# ------------------------------------------------------------------
def _save_image_background(pil_image: Image.Image, original_filename: str, predicted_class: int):
    try:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
        if predicted_class > 0:
            class_folder = f"class{predicted_class}"
        else:
            class_folder = "class0_unknown"

        class_dir = os.path.join(BASE_SAVE_DIR, class_folder)
        os.makedirs(class_dir, exist_ok=True)

        name_part, ext_from_name = os.path.splitext(original_filename)
        safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in name_part)

        if ext_from_name.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"}:
            ext = ext_from_name.lower().replace(".jpeg", ".jpg")
        else:
            ext = ".jpg"

        filename = f"{timestamp}_{safe_name}{ext}"
        save_path = os.path.join(class_dir, filename)

        pil_image.save(save_path, quality=95, optimize=True)
        print(f"✓ Saved image -> {class_folder}/{filename}")
    except Exception as e:
        print(f"✗ Failed to save image: {e}")

@app.post("/upload-images")
async def predict(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        image = Image.open(io.BytesIO(contents)).convert("RGB")

        # ---- GPU inference ----
        results = model(
            source=image,
            imgsz=IMG_SIZE,
            conf=CONF_THRESH,
            device=DEVICE,
            verbose=False,
            save=False,
        )[0]

        # ---- Extract top-1 class ----
        if results.boxes is not None and len(results.boxes) > 0:
            top_idx = results.boxes.conf.argmax()
            cls_id = int(results.boxes.cls[top_idx].item()) + 1
            conf = float(results.boxes.conf[top_idx].item())
            final_id = MAP_RESULTS.get(cls_id, 0)
        else:
            final_id = 0
            conf = 0.0

        # ---- Save in background to correct class folder ----
        threading.Thread(
            target=_save_image_background,
            args=(image.copy(), file.filename, final_id),
            daemon=True
        ).start()

        return JSONResponse({
            "id": final_id,
            "confidence": round(conf, 4)
        })

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference error: {str(e)}")

# ------------------------------------------------------------------
# Run Server
# ------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=cfg.get("server", "host"),
        port=cfg.getint("server", "port"),
        workers=cfg.getint("server", "workers"),
        log_level=cfg.get("server", "log_level"),
    )
