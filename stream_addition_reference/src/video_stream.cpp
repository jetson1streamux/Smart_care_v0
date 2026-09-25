#include "video_stream.h"
#include "utils/logger.h"
#include <iostream>
#include <map>
#include "utils/config.h"

VideoStream::VideoStream() : running(false), picture_widget(nullptr), overlay_widget(nullptr), timeout_id(0) {}

VideoStream::~VideoStream() { stop(); }

void VideoStream::start(const std::string& rtsp_url, GtkPicture* target_picture) {
    stop();
    current_url = rtsp_url;
    picture_widget = target_picture;
    running = true;
    has_real_frame_flag = false;
    frame_ready = false;
    worker_thread = std::thread(&VideoStream::loop, this);
    
    std::map<std::string, std::string> meta = {{"url", rtsp_url}};
    LOG_HEALTH_META(INFO, "video.stream", "HLTH-010", "Video stream started", meta);
    
    // Poll at ~30fps (33ms) — matches typical RTSP source frame rate
    // Higher rates waste CPU without visual benefit since source is ~25-30fps
    timeout_id = g_timeout_add(33, updateUI, this);
}

void VideoStream::stop() {
    if (!running) return;
    running = false;
    
    LOG_HEALTH(INFO, "video.stream", "HLTH-013", "Video stream stopped");
    
    if (timeout_id > 0) {
        g_source_remove(timeout_id);
        timeout_id = 0;
    }
    if (worker_thread.joinable()) {
        worker_thread.join();
    }
}



static std::string urlDecode(std::string str) {
    std::string ret;
    char ch;
    int i, ii;
    for (i=0; i< (int)str.length(); i++) {
        if (str[i] != '%') {
            if (str[i] == '+') ret += ' ';
            else ret += str[i];
        } else if (i + 2 < (int)str.length()) {
            sscanf(str.substr(i + 1, 2).c_str(), "%x", &ii);
            ch = static_cast<char>(ii);
            ret += ch;
            i = i + 2;
        }
    }
    return ret;
}

void VideoStream::loop() {
    std::string actual_url = current_url;
    size_t pos = actual_url.find("mediamtx");
    if (pos != std::string::npos) {
        // Map docker hostname to host IP
        std::string mediamtx_ip = Config::getInstance().get("app", "mediamtx_ip", "");
        if (!mediamtx_ip.empty()) {
            actual_url.replace(pos, 8, mediamtx_ip);
        }
    }

    // GStreamer rtspsrc can struggle with URL-encoded passwords (like %40 for @) and zero latency over TCP.
    // We parse the URL, extract and decode credentials, and explicitly set user-id and user-pw.
    // We also set latency=500 as recommended in comments for stable TCP delivery.
    std::string user_id = "";
    std::string user_pw = "";
    std::string clean_url = actual_url;
    
    size_t protocol_pos = actual_url.find("://");
    if (protocol_pos != std::string::npos) {
        size_t at_pos = actual_url.find('@', protocol_pos + 3);
        if (at_pos != std::string::npos) {
            std::string credentials = actual_url.substr(protocol_pos + 3, at_pos - (protocol_pos + 3));
            size_t colon_pos = credentials.find(':');
            if (colon_pos != std::string::npos) {
                user_id = urlDecode(credentials.substr(0, colon_pos));
                user_pw = urlDecode(credentials.substr(colon_pos + 1));
                clean_url = actual_url.substr(0, protocol_pos + 3) + actual_url.substr(at_pos + 1);
            }
        }
    }

    std::string pipeline = "rtspsrc location=\"" + clean_url + "\" ";
    if (!user_id.empty() && !user_pw.empty()) {
        pipeline += "user-id=\"" + user_id + "\" user-pw=\"" + user_pw + "\" ";
    }
    // Let GStreamer negotiate the best protocol (UDP/TCP) and use default timeouts.
    // Explicitly requesting BGR format in appsink ensures compatibility with OpenCV.
    pipeline += "latency=500 ! rtph264depay ! h264parse ! queue max-size-buffers=30 ! avdec_h264 ! videoconvert ! video/x-raw, format=BGR ! appsink drop=true sync=false";
    
    cv::VideoCapture cap;
    
    auto open_capture = [&](cv::VideoCapture& c) -> bool {
        c.open(pipeline, cv::CAP_GSTREAMER);
        if (c.isOpened()) {
            return true;
        }
        std::map<std::string, std::string> meta = {{"url", actual_url}};
        LOG_HEALTH_META(WARN, "video.stream", "HLTH-011", "GStreamer pipeline failed, falling back to FFMPEG", meta);
        c.open(actual_url, cv::CAP_FFMPEG);
        if (c.isOpened()) {
            LOG_HEALTH(INFO, "video.stream", "HLTH-016", "Successfully opened fallback FFMPEG stream");
            return true;
        } else {
            LOG_HEALTH(ERROR, "video.stream", "HLTH-017", "Failed to open stream with both GStreamer and FFMPEG");
            return false;
        }
    };

    open_capture(cap);
    
    cv::Mat frame;
    int fail_count = 0;
    bool first_frame_logged = false;
    
    while (running) {
        if (cap.read(frame) && !frame.empty()) {
            if (!first_frame_logged) {
                LOG_HEALTH(INFO, "video.stream", "HLTH-015", "First frame successfully read from stream");
                first_frame_logged = true;
            }
            fail_count = 0;

            // OpenCV's internal GStreamer appsink negotiates BGR natively.
            // FFMPEG also returns BGR. So we always convert BGR -> RGB.
            cv::Mat frame_rgb;
            if (frame.channels() == 3) {
                cv::cvtColor(frame, frame_rgb, cv::COLOR_BGR2RGB);
            } else {
                frame_rgb = frame;
            }

            {
                std::lock_guard<std::mutex> lock(frame_mutex);
                // Reuse pre-allocated buffer when dimensions match to avoid heap churn
                if (latest_frame.rows == frame_rgb.rows &&
                     latest_frame.cols == frame_rgb.cols &&
                     latest_frame.type() == frame_rgb.type()) {
                    frame_rgb.copyTo(latest_frame);
                } else {
                    latest_frame = frame_rgb.clone();
                }
                frame_ready = true;
                has_real_frame_flag = true;
            }
        } else {
            fail_count++;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (fail_count > 30 && running) {
                LOG_HEALTH(ERROR, "video.stream", "HLTH-014", "Frame read failure threshold exceeded");
                
                std::map<std::string, std::string> meta = {{"retry", "1"}};
                LOG_HEALTH_META(WARN, "video.stream", "HLTH-012", "Video stream reconnecting", meta);
                
                // Try to reconnect
                cap.release();
                first_frame_logged = false;
                std::this_thread::sleep_for(std::chrono::milliseconds(1000));
                open_capture(cap);
                fail_count = 0;
            }
        }
    }
    cap.release();
}

gboolean VideoStream::updateUI(gpointer data) {
    VideoStream* self = static_cast<VideoStream*>(data);
    if (!self->running || !self->picture_widget) {
        self->timeout_id = 0;
        return G_SOURCE_REMOVE;
    }

    cv::Mat frame_rgb;
    {
        std::lock_guard<std::mutex> lock(self->frame_mutex);
        // Only update the texture when a genuinely new frame is available.
        // Keep displaying the last frame otherwise — no blanking, no jitter.
        if (!self->frame_ready) return G_SOURCE_CONTINUE;
        // Swap instead of clone — zero-copy transfer of ownership
        cv::swap(self->latest_frame, frame_rgb);
        self->frame_ready = false;
    }

    if (frame_rgb.empty()) return G_SOURCE_CONTINUE;

    // Use g_bytes_new_with_free_func to hand ownership to GBytes,
    // avoiding a redundant memcpy. The cv::Mat data is kept alive
    // by capturing the Mat in the release closure.
    cv::Mat* mat_ptr = new cv::Mat(frame_rgb);
    GBytes* bytes = g_bytes_new_with_free_func(
        mat_ptr->data,
        mat_ptr->total() * mat_ptr->elemSize(),
        [](gpointer p) { delete static_cast<cv::Mat*>(p); },
        mat_ptr
    );
    GdkTexture* texture = gdk_memory_texture_new(
        frame_rgb.cols,
        frame_rgb.rows,
        GDK_MEMORY_R8G8B8,
        bytes,
        frame_rgb.step[0]
    );
    
    gtk_picture_set_paintable(self->picture_widget, GDK_PAINTABLE(texture));
    
    // On first real frame, trigger overlay redraw so ROI/lines appear immediately
    if (self->overlay_widget && self->has_real_frame_flag) {
        gtk_widget_queue_draw(self->overlay_widget);
    }

    g_object_unref(texture);
    g_bytes_unref(bytes);

    return G_SOURCE_CONTINUE;
}
