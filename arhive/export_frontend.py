import os
import shutil

src = 'templates/index.html'
dest_dir = 'frontend_export'
dest = os.path.join(dest_dir, 'index.html')

os.makedirs(dest_dir, exist_ok=True)

with open(src, 'r') as f:
    content = f.read()

# Insert the BACKEND_URL prompt at the beginning of the <script> block
script_start = '<script>'
setup_code = '''<script>
        // --- Added for standalone frontend export ---
        const storedUrl = localStorage.getItem('backendUrl');
        const BACKEND_URL = prompt('Enter the Jetson Tailscale Backend URL (e.g., http://100.x.y.z:5000):', storedUrl || 'http://100.x.y.z:5000');
        if (BACKEND_URL) {
            localStorage.setItem('backendUrl', BACKEND_URL);
        } else {
            alert('Backend URL is required!');
        }
'''
content = content.replace(script_start, setup_code, 1)

# Fix fetch calls
content = content.replace("fetch('/api/", "fetch(BACKEND_URL + '/api/")



# Fix video source
content = content.replace('videoSource.src = alert.clip_url;', 'videoSource.src = BACKEND_URL + alert.clip_url;')

# Write patched content
with open(dest, 'w') as f:
    f.write(content)

# Create zip file
shutil.make_archive('frontend_export', 'zip', dest_dir)
print('frontend_export.zip created successfully')
