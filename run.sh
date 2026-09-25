#!/usr/bin/env bash
# =============================================================================
# SmartCare RBATPM — Master Run Script
# =============================================================================
# Validates prerequisites, starts MediaMTX WebRTC server, and launches the
# Python backend. All background services (MediaMTX & RTSP stream proxies)
# are automatically cleaned up when this terminal is closed or interrupted (Ctrl+C).
# =============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${PROJECT_ROOT}/config.ini"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Track background process PIDs for automatic clean termination
SPAWNED_PIDS=()

cleanup() {
    echo -e "\n${YELLOW}🛑 Shutting down SmartCare RBATPM pipeline services...${NC}"
    
    # 1. Kill spawned background ffmpeg stream processes
    if [ ${#SPAWNED_PIDS[@]} -gt 0 ]; then
        echo -e "   Stopping background stream proxies..."
        kill "${SPAWNED_PIDS[@]}" 2>/dev/null || true
    fi
    pkill -f "rtsp://localhost:8554/" 2>/dev/null || true
    pkill -f "ffmpeg.*rtsp://localhost:8554" 2>/dev/null || true

    # 2. Stop and remove MediaMTX Docker container
    echo -e "   Stopping MediaMTX container..."
    docker stop smartcare_mediamtx 2>/dev/null || docker kill smartcare_mediamtx 2>/dev/null || true
    docker rm smartcare_mediamtx 2>/dev/null || true

    echo -e "${GREEN}✅ All pipeline services stopped cleanly.${NC}\n"
}

# Register signal trap handler for clean exit on terminal closure or Ctrl+C
trap cleanup EXIT INT TERM HUP

echo -e "${CYAN}══════════════════════════════════════════════${NC}"
echo -e "${CYAN}   SmartCare RBATPM — Pipeline Runner         ${NC}"
echo -e "${CYAN}══════════════════════════════════════════════${NC}\n"

# ─────────────────────────────────────────────
# 1. Prerequisites Check
# ─────────────────────────────────────────────
echo -e "${YELLOW}[1/4] System Checks...${NC}"

if [ ! -f "${CONFIG_FILE}" ]; then
    echo -e "${RED}❌ config.ini not found at ${CONFIG_FILE}${NC}"
    exit 1
fi
echo -e "${GREEN}✅ config.ini found.${NC}"

if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ python3 not found. Please install Python 3.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ python3 available.${NC}"

if ! systemctl is-active --quiet docker 2>/dev/null; then
    echo -e "${YELLOW}⚠️  Docker service is not running. Attempting to start...${NC}"
    sudo systemctl start docker 2>/dev/null || true
    sleep 2
    if ! systemctl is-active --quiet docker 2>/dev/null; then
        echo -e "${RED}❌ Docker service could not be started. MediaMTX WebRTC will not be available.${NC}"
        echo -e "${YELLOW}   The Python backend will still launch without WebRTC streams.${NC}"
        DOCKER_AVAILABLE=false
    else
        echo -e "${GREEN}✅ Docker started successfully.${NC}"
        DOCKER_AVAILABLE=true
    fi
else
    echo -e "${GREEN}✅ Docker is running.${NC}"
    DOCKER_AVAILABLE=true
fi

# Check GPU availability
if python3 -c "import torch; assert torch.cuda.is_available()" 2>/dev/null; then
    echo -e "${GREEN}✅ CUDA GPU detected.${NC}"
else
    echo -e "${RED}❌ CUDA not available. Model inference will fail.${NC}"
    exit 1
fi

# ─────────────────────────────────────────────
# 2. Parse config.ini for MediaMTX settings
# ─────────────────────────────────────────────
echo -e "\n${YELLOW}[2/4] Resolving Configuration...${NC}"

eval $(python3 -c "
import configparser, os
c = configparser.ConfigParser(inline_comment_prefixes=('#',), interpolation=None)
c.read('${CONFIG_FILE}')
print(f\"HOST_IP='{c.get('mediamtx', 'host_ip', fallback='100.94.110.18')}'\")
print(f\"WEBRTC_PORT='{c.get('mediamtx', 'webrtc_port', fallback='8889')}'\")
print(f\"DOCKER_IMAGE='{c.get('mediamtx', 'docker_image', fallback='bluenviron/mediamtx')}'\")
print(f\"MTX_CONFIG='{os.path.join('${PROJECT_ROOT}', c.get('mediamtx', 'mediamtx_config', fallback='mediamtx.yml'))}'\")
print(f\"SERVER_HOST='{c.get('server', 'host', fallback='0.0.0.0')}'\")
print(f\"SERVER_PORT='{c.get('server', 'port', fallback='5000')}'\")
")

echo -e "${GREEN}✅ Backend  : ${SERVER_HOST}:${SERVER_PORT}${NC}"
echo -e "${GREEN}✅ MediaMTX : WebRTC on port ${WEBRTC_PORT}, Host IP ${HOST_IP}${NC}"
echo -e "${GREEN}✅ Config   : ${MTX_CONFIG}${NC}"

# ─────────────────────────────────────────────
# 3. Start MediaMTX Docker & RTSP Stream Proxies
# ─────────────────────────────────────────────
echo -e "\n${YELLOW}[3/4] Starting MediaMTX and ffmpeg streams...${NC}"

# Clean up existing processes (backend, MediaMTX container, ffmpeg streams)
echo -e "   Cleaning up existing processes..."
pkill -f "python3 main.py" 2>/dev/null || true
if [ -n "${SERVER_PORT:-}" ]; then
    fuser -k "${SERVER_PORT}/tcp" 2>/dev/null || true
fi
sleep 1

if [ "${DOCKER_AVAILABLE}" = true ]; then
    docker kill smartcare_mediamtx 2>/dev/null || true
    docker rm smartcare_mediamtx 2>/dev/null || true
    docker ps -q --filter ancestor="${DOCKER_IMAGE}" 2>/dev/null | xargs -r docker kill 2>/dev/null || true
    pkill -f "ffmpeg.*rtsp://localhost:8554" 2>/dev/null || true
    sleep 1

    if [ ! -f "${MTX_CONFIG}" ]; then
        echo -e "${RED}❌ mediamtx.yml not found at ${MTX_CONFIG}${NC}"
        echo -e "${YELLOW}   Skipping MediaMTX. Live WebRTC streams will not work.${NC}"
    else
        echo -e "   🚀 Launching MediaMTX Docker container in background..."
        docker run -d --rm --name smartcare_mediamtx --network host \
            -e MTX_WEBRTCADDITIONALHOSTS="${HOST_IP}" \
            -v "${MTX_CONFIG}":/mediamtx.yml \
            "${DOCKER_IMAGE}" >/dev/null 2>&1
        
        # Give MediaMTX a moment to initialize
        sleep 2

        echo -e "   🚀 Launching ffmpeg RTSP proxy streams in background..."
        while IFS= read -r cmd; do
            if [ -n "$cmd" ]; then
                eval "$cmd"
            fi
        done < <(python3 -c "
import configparser
c = configparser.ConfigParser(inline_comment_prefixes=('#',), interpolation=None)
c.read('${CONFIG_FILE}')
cam_idx = 1
while True:
    rtsp = c.get('cameras', f'cam{cam_idx}_url', fallback=None)
    stream_name = c.get('mediamtx', f'cam{cam_idx}_stream', fallback=None)
    if not rtsp or not stream_name:
        break
    print(f\"ffmpeg -hide_banner -loglevel error -fflags nobuffer -flags low_delay -rtsp_transport tcp -i '{rtsp}' -c copy -f rtsp rtsp://localhost:8554/{stream_name} >/dev/null 2>&1 & SPAWNED_PIDS+=(\\\$!)\")
    cam_idx += 1
")
        echo -e "${GREEN}✅ MediaMTX and ffmpeg streams running smoothly in background.${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Skipping MediaMTX (Docker unavailable).${NC}"
fi

# ─────────────────────────────────────────────
# 4. Launch Python Backend
# ─────────────────────────────────────────────
echo -e "\n${YELLOW}[4/4] Starting SmartCare RBATPM Backend...${NC}"
echo -e "${CYAN}══════════════════════════════════════════════${NC}"
echo -e "${GREEN}   Dashboard: http://${HOST_IP}:${SERVER_PORT}/${NC}"
echo -e "${CYAN}══════════════════════════════════════════════${NC}\n"

cd "${PROJECT_ROOT}"
python3 main.py
