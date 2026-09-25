#!/usr/bin/env python3
import socket
import subprocess
import os
import sys
import threading
import time
import configparser
import urllib.parse
from pymongo import MongoClient

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

config = configparser.ConfigParser()
config.read(os.path.join(PROJECT_ROOT, 'config.ini'))

UDP_IP = config['Network']['UDP_IP']
UDP_PORT = int(config['Network']['UDP_PORT'])
UI_UDP_PORT = int(config['Network']['UI_UDP_PORT'])

# Hardcoded client IP
last_client_ip = config['Network']['LAST_CLIENT_IP']

# Paths
SYNC_SCRIPT = os.path.join(PROJECT_ROOT, config['Paths']['SYNC_SCRIPT'])
DEEPSTREAM_APP_NAME = config['AI']['DEEPSTREAM_APP_NAME']
RUN_PIPELINE_SCRIPT = os.path.join(PROJECT_ROOT, config['Paths']['RUN_PIPELINE_SCRIPT'])

db_user = urllib.parse.quote_plus(config['Database']['MONGO_ADMIN_USER'])
db_pass = urllib.parse.quote_plus(config['Database']['MONGO_ADMIN_PASS'])
MONGO_URI = f"mongodb://{db_user}:{db_pass}@{config['Database']['MONGO_HOST']}:{config['Database']['MONGO_PORT']}/?authSource=admin"

def run_sync():
    print("📝 Running sync_analytics.py...")
    subprocess.run(["python3", SYNC_SCRIPT])

def restart_pipeline():
    print("🔄 Restarting DeepStream Pipeline...")
    
    try:
        # Stop any existing run_pipeline.sh scripts and deepstream_app processes
        subprocess.run(["pkill", "-f", "run_pipeline.sh"])
        subprocess.run(["pkill", "-f", DEEPSTREAM_APP_NAME])
        print("💀 Terminated existing pipeline scripts and deepstream_app processes.")
    except Exception as e:
        print(f"Error terminating process: {e}")

    # Launch run_pipeline.sh in a new gnome-terminal
    try:
        print(f"🚀 Spawning run_pipeline.sh in a new terminal...")
        # Start in a new terminal so it pops up
        subprocess.Popen(
            ["gnome-terminal", "--", "bash", "-c", f"{RUN_PIPELINE_SCRIPT}; exec bash"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            preexec_fn=os.setpgrp
        )
    except Exception as e:
        print(f"❌ Failed to run pipeline: {e}")

def start_http_server():
    print("🌐 Starting HTTP Server on port 5002...")
    try:
        # Stop any existing server on port 5002
        subprocess.run(["pkill", "-f", "python3 -m http.server 5002"])
        print("💀 Terminated existing HTTP server processes.")
    except Exception as e:
        print(f"Error terminating HTTP server: {e}")

    try:
        print("🚀 Spawning HTTP Server in background terminal...")
        subprocess.Popen(
            ["gnome-terminal", "--", "bash", "-c", f"cd {os.path.join(PROJECT_ROOT, 'AI_Pipeline')} && python3 -m http.server 5002; exec bash"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            preexec_fn=os.setpgrp
        )
    except Exception as e:
        print(f"❌ Failed to run HTTP server: {e}")

def restart_mediamtx_and_streams():
    print("🔄 Restarting MediaMTX and ffmpeg streams...")
    try:
        subprocess.run(["pkill", "-f", "ffmpeg -re -stream_loop"])
        subprocess.run(["bash", "-c", "docker ps -q --filter ancestor=bluenviron/mediamtx | xargs -r docker kill"])
        print("💀 Terminated existing ffmpeg streams and mediamtx docker.")
    except Exception as e:
        print(f"Error terminating mediamtx/ffmpeg: {e}")

    try:
        print("🚀 Spawning MediaMTX Docker in background terminal...")
        subprocess.Popen(
            ["gnome-terminal", "--", "bash", "-c", f"cd {os.path.join(PROJECT_ROOT, 'mediamtx')} && echo 'Starting MediaMTX...' && docker run --rm -it --network host -e MTX_WEBRTCADDITIONALHOSTS=100.94.110.18 -v \"$(pwd)/mediamtx.yml:/mediamtx.yml\" bluenviron/mediamtx; exec bash"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            preexec_fn=os.setpgrp
        )
    except Exception as e:
        print(f"❌ Failed to run MediaMTX: {e}")

    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        db_streams = list(client.user_bajaj_db.streams.find().sort("order_index", 1))
        
        # Give MediaMTX a moment to start
        time.sleep(3)
        
        for i, doc in enumerate(db_streams):
            db_rtsp_url = doc.get("rtsp_url", "")
            if not db_rtsp_url:
                continue
                
            stream_name = f"stream{i + 1}"
            output_rtsp = f"rtsp://localhost:8554/{stream_name}"
            input_rtsp = db_rtsp_url
            
            cmd = f"ffmpeg -re -stream_loop -1 -i '{input_rtsp}' -c copy -f rtsp {output_rtsp}"
            print(f"🚀 Spawning ffmpeg for {stream_name} in background terminal...")
            subprocess.Popen(
                ["gnome-terminal", "--", "bash", "-c", f"{cmd}; exec bash"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                preexec_fn=os.setpgrp
            )
            
    except Exception as e:
        print(f"❌ Failed to fetch streams and start ffmpeg: {e}")

def db_monitor_thread():
    print("🔍 Starting MongoDB write monitor thread...")
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        # Verify connection
        client.admin.command('ping')
    except Exception as e:
        print(f"❌ Failed to connect to MongoDB for monitoring: {e}")
        return

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    
    # Get initial counters
    try:
        initial_status = client.admin.command("serverStatus")
        opcounters = initial_status.get("opcounters", {})
        last_writes = opcounters.get("insert", 0) + opcounters.get("update", 0) + opcounters.get("delete", 0)
    except Exception as e:
        print(f"❌ Failed to get initial serverStatus: {e}")
        last_writes = 0

    while True:
        try:
            time.sleep(1) # Poll every 1 second
            status = client.admin.command("serverStatus")
            opcounters = status.get("opcounters", {})
            current_writes = opcounters.get("insert", 0) + opcounters.get("update", 0) + opcounters.get("delete", 0)
            
            if current_writes > last_writes:
                # A write has occurred!
                if last_client_ip:
                    print(f"💾 DB Write detected ({current_writes - last_writes} new writes). Sending REFRESH_UI to client {last_client_ip}:{UI_UDP_PORT}...")
                    try:
                        sock.sendto(b"REFRESH_UI", (last_client_ip, UI_UDP_PORT))
                    except Exception as e:
                        print(f"⚠️ Failed to send UDP signal to UI: {e}")
                else:
                    print(f"💾 DB Write detected, but no client IP is known yet (waiting for first packet from client).")
                last_writes = current_writes
        except Exception as e:
            print(f"⚠️ MongoDB monitoring error: {e}")
            time.sleep(5) # Wait a bit before retrying on error

def main():
    # Start the DB monitoring thread
    monitor_thread = threading.Thread(target=db_monitor_thread, daemon=True)
    monitor_thread.start()

    print("🚀 Initializing startup sequence...")
    run_sync()
    restart_pipeline()
    start_http_server()
    restart_mediamtx_and_streams()
    print("✅ Startup sequence complete.")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((UDP_IP, UDP_PORT))
    print(f"🛰️ Listening for UDP triggers on port {UDP_PORT}...")

    while True:
        data, addr = sock.recvfrom(1024)
        message = data.decode("utf-8").strip()
        
        # (Disabled dynamic IP tracking to force hardcoded IP)
        # global last_client_ip
        # last_client_ip = addr[0]
        
        print(f"🔔 Received message '{message}' from {addr}")
        
        if message == "RESTART":
            run_sync()
            restart_pipeline()
            start_http_server()
            restart_mediamtx_and_streams()
            print("✅ Restart sequence complete. Resuming listener...\n")

if __name__ == "__main__":
    main()
