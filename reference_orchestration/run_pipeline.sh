#!/bin/bash

# Navigate to script directory
cd "$(dirname "$0")"

# 1. Fetch DB config and generate config_nvdsanalytics.txt
echo "Fetching configuration from MongoDB..."
URLS=$(python3 fetch_config.py)
if [ $? -ne 0 ]; then
    echo "Failed to fetch config. Exiting."
    exit 1
fi

if [ -z "$URLS" ]; then
    echo "No RTSP URLs found in configuration. Exiting."
    exit 1
fi

echo "RTSP URLs: $URLS"

# 2. Build C++ code if necessary
echo "Building C++ application..."
make

if [ $? -ne 0 ]; then
    echo "Failed to build C++ application. Exiting."
    exit 1
fi

# 3. Run the C++ application
echo "Starting DeepStream Pipeline..."
./deepstream_app $URLS
