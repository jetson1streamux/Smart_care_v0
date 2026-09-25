#!/usr/bin/env python3
import sys
import os
import configparser
import urllib.parse
from pymongo import MongoClient
from pymongo.errors import PyMongoError

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

# Configuration
config = configparser.ConfigParser()
config.read(os.path.join(PROJECT_ROOT, 'config.ini'))

db_user = urllib.parse.quote_plus(config['Database']['MONGO_ADMIN_USER'])
db_pass = urllib.parse.quote_plus(config['Database']['MONGO_ADMIN_PASS'])
MONGO_URI = f"mongodb://{db_user}:{db_pass}@{config['Database']['MONGO_HOST']}:{config['Database']['MONGO_PORT']}/?authSource=admin"
DB_NAME = config['Database']['DB_NAME']
COLLECTION_NAME = config['Database']['CONFIG_COLLECTION']
CONFIG_FILE_PATH = os.path.join(PROJECT_ROOT, config['Paths']['ANALYTICS_CONFIG'])
CONFIG_NAME = config['Database']['CONFIG_NAME']

def sync_to_file(doc, file_path):
    # Try using raw_text first if it exists
    raw_text = doc.get("raw_text")
    if raw_text:
        print("📝 Using raw_text to generate config...")
        lines = raw_text.splitlines()
        
        sections = []
        current_section = None
        current_lines = []
        
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                if current_section is not None:
                    sections.append((current_section, current_lines))
                current_section = stripped[1:-1].strip()
                current_lines = [line]
            elif current_section is not None and stripped:
                current_lines.append(line)
        
        if current_section is not None:
            sections.append((current_section, current_lines))
            
        output_lines = []
        
        for sec_name, sec_lines in sections:
            if sec_name == "property":
                output_lines.extend(sec_lines)
                output_lines.append("")
                continue
                
            keep = False
            if sec_name.startswith("roi-filtering-stream-"):
                if any(l.strip().startswith("roi-") for l in sec_lines[1:]):
                    keep = True
            elif sec_name.startswith("line-crossing-stream-"):
                if any(l.strip().startswith("line-crossing-") for l in sec_lines[1:]):
                    keep = True
            elif sec_name.startswith("direction-detection-stream-"):
                if any(l.strip().startswith("direction-") for l in sec_lines[1:]):
                    keep = True
                    
            if keep:
                output_lines.extend(sec_lines)
                output_lines.append("")

        content = "\n".join(output_lines).strip() + "\n"
        with open(file_path, 'w') as f:
            f.write(content)
        print(f"📄 Updated (from raw_text): {file_path}")
    else:
        # Fallback to the dictionary method if raw_text is not present
        print("⚠️ raw_text not found in document. Falling back to dict data...")
        data = doc.get("data", {})
        lines = []
        
        if "property" in data:
            lines.append("[property]")
            for key, value in data["property"].items():
                if isinstance(value, list):
                    for v in value: lines.append(f"{key} = {v}")
                else:
                    lines.append(f"{key} = {value}")
            lines.append("")

        for section, options in data.items():
            if section == "property":
                continue
                
            keep = False
            if section.startswith("roi-filtering-stream-"):
                if any(k.startswith("roi-") for k in options.keys()):
                    keep = True
            elif section.startswith("line-crossing-stream-"):
                if any(k.startswith("line-crossing-") for k in options.keys()):
                    keep = True
            elif section.startswith("direction-detection-stream-"):
                if any(k.startswith("direction-") for k in options.keys()):
                    keep = True
                    
            if keep:
                lines.append(f"[{section}]")
                for key, value in options.items():
                    if isinstance(value, list):
                        for v in value: lines.append(f"{key} = {v}")
                    else:
                        lines.append(f"{key} = {value}")
                lines.append("")
        
        with open(file_path, 'w') as f:
            f.write("\n".join(lines))
        print(f"📄 Updated (from dict data): {file_path}")

def main():
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        db = client[DB_NAME]
        collection = db[COLLECTION_NAME]
        
        doc = collection.find_one({"config_name": CONFIG_NAME})
        if doc:
            sync_to_file(doc, CONFIG_FILE_PATH)
            print("🚀 Configuration sync completed successfully.")
            sys.exit(0)
        else:
            print(f"❌ Error: Config document '{CONFIG_NAME}' not found in {DB_NAME}.{COLLECTION_NAME}.")
            sys.exit(1)
            
    except PyMongoError as e:
        print(f"❌ MongoDB connection or query error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Unexpected error during sync: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
