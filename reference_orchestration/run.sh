#!/usr/bin/env bash
# Global Run Script for building_database project

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${PROJECT_ROOT}/config.ini"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}══════════════════════════════════════════${NC}"
echo -e "${CYAN}     Building_Database Pipeline Runner    ${NC}"
echo -e "${CYAN}══════════════════════════════════════════${NC}\n"

# 1. Prerequisites Check
echo -e "${YELLOW}[1/3] System Checks...${NC}"

if [ ! -f "${CONFIG_FILE}" ]; then
    echo -e "${RED}❌ config.ini not found! Please run ./build.sh first.${NC}"
    exit 1
fi

if ! systemctl is-active --quiet mongod; then
    echo -e "${RED}❌ MongoDB service is not running. Please start it: sudo systemctl start mongod${NC}"
    exit 1
else
    echo -e "${GREEN}✅ MongoDB is running.${NC}"
fi

if ! systemctl is-active --quiet docker; then
    echo -e "${RED}❌ Docker service is not running. Required for MediaMTX.${NC}"
    exit 1
else
    echo -e "${GREEN}✅ Docker is running.${NC}"
fi

# 2. Extract orchestrator path dynamically
echo -e "\n${YELLOW}[2/3] Resolving Orchestrator...${NC}"
eval $(python3 -c "
import configparser
import os
c = configparser.ConfigParser()
c.read('$CONFIG_FILE')
print(f\"SYNC_SCRIPT='{os.path.join('$PROJECT_ROOT', c['Paths']['SYNC_SCRIPT'])}'\")
")

# trigger_listener.py is assumed to be next to sync_analytics.py
TRIGGER_SCRIPT="$(dirname "${SYNC_SCRIPT}")/trigger_listener.py"

if [ ! -f "${TRIGGER_SCRIPT}" ]; then
    echo -e "${RED}❌ Orchestrator script not found at ${TRIGGER_SCRIPT}${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Found orchestrator: ${TRIGGER_SCRIPT}${NC}"

# 3. Launch Pipeline
echo -e "\n${YELLOW}[3/3] Starting Orchestrator...${NC}"
echo -e "${CYAN}══════════════════════════════════════════${NC}"
python3 "${TRIGGER_SCRIPT}"
