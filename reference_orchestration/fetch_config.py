#!/usr/bin/env python3
import sys
import os
import configparser
import urllib.parse
from pymongo import MongoClient

def main():
    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
    PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
    
    config = configparser.ConfigParser()
    config.read(os.path.join(PROJECT_ROOT, 'config.ini'))

    db_user = urllib.parse.quote_plus(config['Database']['MONGO_APP_USER'])
    db_pass = urllib.parse.quote_plus(config['Database']['MONGO_APP_PASS'])
    uri = f"mongodb://{db_user}:{db_pass}@{config['Database']['MONGO_HOST']}:{config['Database']['MONGO_PORT']}/?authSource=admin"
    db_name = config['Database']['DB_NAME']
    streams_collection_name = config['Database']['STREAMS_COLLECTION']
    
    try:
        client = MongoClient(uri, serverSelectionTimeoutMS=5000)
        db = client[db_name]
        
        # Query streams collection and sort by order_index
        streams_col = db[streams_collection_name]
        streams = list(streams_col.find().sort("order_index", 1))
        
        if not streams:
            sys.stderr.write("Error: No streams found in the database.\n")
            sys.exit(1)
            
        urls = []
        for stream in streams:
            url = stream.get("rtsp_url", "")
            if url:
                urls.append(url)
                
        # Output URLs separated by space for bash to capture
        print(" ".join(urls))

    except Exception as e:
        sys.stderr.write(f"Exception during config fetch: {e}\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
