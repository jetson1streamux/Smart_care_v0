#include <gst/gst.h>
#include <glib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <sys/time.h>
#include <sys/stat.h>
#include <unistd.h>
#include <map>
#include <vector>
#include <string>
#include <iostream>
#include <limits.h>

#include <opencv2/opencv.hpp>

#include <mongoc/mongoc.h>
#include <bson/bson.h>

#include "gstnvdsmeta.h"
#include "nvds_analytics_meta.h"
#include "nvbufsurface.h"
#include "nvbufsurftransform.h"

using namespace std;
using namespace cv;

int MUXER_OUTPUT_WIDTH = 1280;
int MUXER_OUTPUT_HEIGHT = 720;
#define MUXER_BATCH_TIMEOUT_USEC 33000

#define PGIE_CLASS_ID_PERSON 0

static mongoc_client_t *mongo_client = NULL;
static mongoc_collection_t *mongo_collection = NULL;

string folder_name = "../data";
string db_folder_name = "/data";

// Structs for state
struct RoiDwellState {
    double enter_time;
    double last_seen;
    double dwell;
};

struct FallState {
    double first_fall_time;
    double last_fall_time;
    double last_seen;
    bool is_falling;
    bool event_triggered;
};

// Maps for tracking
map<string, RoiDwellState> roi_dwell_state;
map<string, FallState> person_fall_state;
map<string, bool> roi_entry_state;
map<string, bool> line_entry_state;

float DWELL_GRACE_SEC = 1.0f;
float FALL_RECOVERY_SEC = 1.5f;
float FALL_TRIGGER_SEC = 5.0f;
float FALL_GRACE_SEC = 2.0f;

double get_current_time_sec() {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec + tv.tv_usec / 1000000.0;
}

string get_current_date_str() {
    time_t rawtime;
    struct tm * timeinfo;
    char buffer[80];
    time(&rawtime);
    timeinfo = localtime(&rawtime);
    strftime(buffer, sizeof(buffer), "%Y-%m-%d", timeinfo);
    return string(buffer);
}

string get_current_time_str() {
    time_t rawtime;
    struct tm * timeinfo;
    char buffer[80];
    time(&rawtime);
    timeinfo = localtime(&rawtime);
    strftime(buffer, sizeof(buffer), "%H:%M:%S", timeinfo);
    return string(buffer);
}

void insert_event_to_mongo(const char* event_type, const char* area_name, int object_id, int class_id, int stream_id, int frame_number, const string& img_path, double dwell_start_ts) {
    if (!mongo_collection) return;

    bson_t *doc = BCON_NEW(
        "event_type", BCON_UTF8(event_type),
        "area_name", BCON_UTF8(area_name),
        "object_id", BCON_INT32(object_id),
        "class_id", BCON_INT32(class_id),
        "stream_id", BCON_INT32(stream_id),
        "frame_number", BCON_INT32(frame_number),
        "image_path", BCON_UTF8(img_path.c_str()),
        "date", BCON_UTF8(get_current_date_str().c_str()),
        "time", BCON_UTF8(get_current_time_str().c_str()),
        "is_verified", BCON_BOOL(false)
    );

    if (dwell_start_ts > 0) {
        BSON_APPEND_DOUBLE(doc, "dwell_start_ts", dwell_start_ts);
    }

    bson_error_t error;
    if (!mongoc_collection_insert_one(mongo_collection, doc, NULL, NULL, &error)) {
        cerr << "❌ MongoDB Insert Error: " << error.message << endl;
    } else {
        cout << "✅ Inserted event into MongoDB: " << event_type << " " << area_name << " id:" << object_id << endl;
    }
    bson_destroy(doc);
}

static GstPadProbeReturn pgie_src_pad_buffer_probe(GstPad *pad, GstPadProbeInfo *info, gpointer u_data) {
    GstBuffer *buf = (GstBuffer *)info->data;
    NvDsBatchMeta *batch_meta = gst_buffer_get_nvds_batch_meta(buf);
    if (!batch_meta) return GST_PAD_PROBE_OK;

    double now_ts = get_current_time_sec();

    for (NvDsMetaList *l_frame = batch_meta->frame_meta_list; l_frame != NULL; l_frame = l_frame->next) {
        NvDsFrameMeta *frame_meta = (NvDsFrameMeta *)(l_frame->data);
        int stream_id = frame_meta->pad_index;
        int frame_number = frame_meta->frame_num;
        bool frame_saved = false;
        string img_path = "";



        for (NvDsMetaList *l_obj = frame_meta->obj_meta_list; l_obj != NULL; l_obj = l_obj->next) {
            NvDsObjectMeta *obj_meta = (NvDsObjectMeta *)(l_obj->data);
            int object_id = obj_meta->object_id;
            int class_id = obj_meta->class_id;


            if (class_id == PGIE_CLASS_ID_PERSON) {
                string key_obj = to_string(stream_id) + "_" + to_string(object_id);

                if (person_fall_state.find(key_obj) == person_fall_state.end()) {
                    person_fall_state[key_obj] = {0.0, 0.0, now_ts, false, false};
                } else {
                    person_fall_state[key_obj].last_seen = now_ts;
                }

                if (obj_meta->rect_params.width > obj_meta->rect_params.height) {
                    if (!person_fall_state[key_obj].is_falling) {
                        person_fall_state[key_obj].first_fall_time = now_ts;
                        person_fall_state[key_obj].is_falling = true;
                    }
                    person_fall_state[key_obj].last_fall_time = now_ts;

                    if (!person_fall_state[key_obj].event_triggered && (now_ts - person_fall_state[key_obj].first_fall_time > FALL_TRIGGER_SEC)) {
                        person_fall_state[key_obj].event_triggered = true;

                        if (!frame_saved) {
                            GstMapInfo in_map_info;
                            if (gst_buffer_map(buf, &in_map_info, GST_MAP_READ)) {
                                NvBufSurface *surface = (NvBufSurface *)in_map_info.data;
                                if (NvBufSurfaceMap(surface, -1, -1, NVBUF_MAP_READ) == 0) {
                                    if (NvBufSurfaceSyncForCpu(surface, -1, -1) == 0) {
                                        Mat bgra(surface->surfaceList[frame_meta->batch_id].height,
                                                 surface->surfaceList[frame_meta->batch_id].width,
                                                 CV_8UC4,
                                                 surface->surfaceList[frame_meta->batch_id].mappedAddr.addr[0],
                                                 surface->surfaceList[frame_meta->batch_id].pitch);
                                        
                                        img_path = folder_name + "/stream_" + to_string(stream_id) + "/fall_obj_" + to_string(object_id) + "_frame_" + to_string(frame_number) + ".jpg";
                                        string cmd = "mkdir -p " + folder_name + "/stream_" + to_string(stream_id);
                                        int ret = system(cmd.c_str()); (void)ret;
                                        
                                        Mat bgr;
                                        cvtColor(bgra, bgr, COLOR_RGBA2BGRA);
                                        imwrite(img_path, bgr);
                                        frame_saved = true;
                                    }
                                    NvBufSurfaceUnMap(surface, -1, -1);
                                }
                                gst_buffer_unmap(buf, &in_map_info);
                            }
                        }
                        string db_img_path = db_folder_name + "/stream_" + to_string(stream_id) + "/fall_obj_" + to_string(object_id) + "_frame_" + to_string(frame_number) + ".jpg";
                        insert_event_to_mongo("fall_detection", "none", object_id, class_id, stream_id, frame_number, db_img_path, 0);
                    }
                } else {
                    if (person_fall_state[key_obj].is_falling && (now_ts - person_fall_state[key_obj].last_fall_time > FALL_RECOVERY_SEC)) {
                        person_fall_state[key_obj].is_falling = false;
                        person_fall_state[key_obj].event_triggered = false;
                    }
                }

                for (NvDsMetaList *l_user = obj_meta->obj_user_meta_list; l_user != NULL; l_user = l_user->next) {
                    NvDsUserMeta *user_meta = (NvDsUserMeta *)(l_user->data);
                    if (user_meta->base_meta.meta_type == nvds_get_user_meta_type((char*)"NVIDIA.DSANALYTICSOBJ.USER_META")) {
                        NvDsAnalyticsObjInfo *user_meta_data = (NvDsAnalyticsObjInfo *)(user_meta->user_meta_data);

                        // ROI Processing
                        for (auto const& roi : user_meta_data->roiStatus) {
                            string roi_name = string(roi);
                            string key_roi = to_string(stream_id) + "_" + roi_name + "_" + to_string(object_id);

                            if (roi_dwell_state.find(key_roi) == roi_dwell_state.end()) {
                                roi_dwell_state[key_roi] = {now_ts, now_ts, 0.0};
                            } else {
                                roi_dwell_state[key_roi].last_seen = now_ts;
                                roi_dwell_state[key_roi].dwell = now_ts - roi_dwell_state[key_roi].enter_time;
                            }

                            char dwell_str[64];
                            snprintf(dwell_str, sizeof(dwell_str), "%.1fs in %s", roi_dwell_state[key_roi].dwell, roi_name.c_str());
                            
                            string final_text = "ID: " + to_string(object_id) + "\n" +
                                                string(dwell_str);

                            if (obj_meta->text_params.display_text) {
                                g_free(obj_meta->text_params.display_text);
                            }
                            obj_meta->text_params.display_text = g_strdup(final_text.c_str());

                            if (roi_entry_state.find(key_roi) == roi_entry_state.end()) {
                                if (!frame_saved) {
                                    // Handle NVMM map in C++
                                    GstMapInfo in_map_info;
                                    if (gst_buffer_map(buf, &in_map_info, GST_MAP_READ)) {
                                        NvBufSurface *surface = (NvBufSurface *)in_map_info.data;
                                        if (NvBufSurfaceMap(surface, -1, -1, NVBUF_MAP_READ) == 0) {
                                            if (NvBufSurfaceSyncForCpu(surface, -1, -1) == 0) {
                                                Mat bgra(surface->surfaceList[frame_meta->batch_id].height,
                                                         surface->surfaceList[frame_meta->batch_id].width,
                                                         CV_8UC4,
                                                         surface->surfaceList[frame_meta->batch_id].mappedAddr.addr[0],
                                                         surface->surfaceList[frame_meta->batch_id].pitch);
                                                
                                                img_path = folder_name + "/stream_" + to_string(stream_id) + "/roi_" + roi_name + "_obj_" + to_string(object_id) + "_frame_" + to_string(frame_number) + ".jpg";
                                                string cmd = "mkdir -p " + folder_name + "/stream_" + to_string(stream_id);
                                                int ret = system(cmd.c_str()); (void)ret;
                                                
                                                Mat bgr;
                                                cvtColor(bgra, bgr, COLOR_RGBA2BGRA);
                                                imwrite(img_path, bgr);
                                                frame_saved = true;
                                            }
                                            NvBufSurfaceUnMap(surface, -1, -1);
                                        }
                                        gst_buffer_unmap(buf, &in_map_info);
                                    }
                                }
                                string db_img_path = db_folder_name + "/stream_" + to_string(stream_id) + "/roi_" + roi_name + "_obj_" + to_string(object_id) + "_frame_" + to_string(frame_number) + ".jpg";
                                insert_event_to_mongo("roi_entry", roi_name.c_str(), object_id, class_id, stream_id, frame_number, db_img_path, roi_dwell_state[key_roi].enter_time);
                                roi_entry_state[key_roi] = true;
                            }
                        }

                        // Line Crossing
                        for (auto const& line : user_meta_data->lcStatus) {
                            string line_name = string(line);
                            string key_line = to_string(stream_id) + "_" + line_name + "_" + to_string(object_id);

                            if (line_entry_state.find(key_line) == line_entry_state.end()) {
                                if (!frame_saved) {
                                    GstMapInfo in_map_info;
                                    if (gst_buffer_map(buf, &in_map_info, GST_MAP_READ)) {
                                        NvBufSurface *surface = (NvBufSurface *)in_map_info.data;
                                        if (NvBufSurfaceMap(surface, -1, -1, NVBUF_MAP_READ) == 0) {
                                            if (NvBufSurfaceSyncForCpu(surface, -1, -1) == 0) {
                                                Mat bgra(surface->surfaceList[frame_meta->batch_id].height,
                                                         surface->surfaceList[frame_meta->batch_id].width,
                                                         CV_8UC4,
                                                         surface->surfaceList[frame_meta->batch_id].mappedAddr.addr[0],
                                                         surface->surfaceList[frame_meta->batch_id].pitch);
                                                
                                                img_path = folder_name + "/stream_" + to_string(stream_id) + "/line_" + line_name + "_obj_" + to_string(object_id) + "_frame_" + to_string(frame_number) + ".jpg";
                                                string cmd = "mkdir -p " + folder_name + "/stream_" + to_string(stream_id);
                                                int ret = system(cmd.c_str()); (void)ret;
                                                
                                                Mat bgr;
                                                cvtColor(bgra, bgr, COLOR_RGBA2BGRA);
                                                imwrite(img_path, bgr);
                                                frame_saved = true;
                                            }
                                            NvBufSurfaceUnMap(surface, -1, -1);
                                        }
                                        gst_buffer_unmap(buf, &in_map_info);
                                    }
                                }
                                string db_img_path = db_folder_name + "/stream_" + to_string(stream_id) + "/line_" + line_name + "_obj_" + to_string(object_id) + "_frame_" + to_string(frame_number) + ".jpg";
                                insert_event_to_mongo("line_crossing", line_name.c_str(), object_id, class_id, stream_id, frame_number, db_img_path, 0);
                                line_entry_state[key_line] = true;
                            }
                        }
                    }
                }
            }
        }

        // Cleanup ROI states
        vector<string> to_remove_roi;
        for (auto const& [key, state] : roi_dwell_state) {
            if (key.rfind(to_string(stream_id) + "_", 0) == 0) {
                if (now_ts - state.last_seen > DWELL_GRACE_SEC) {
                    to_remove_roi.push_back(key);
                }
            }
        }
        for (const auto& k : to_remove_roi) {
            roi_dwell_state.erase(k);
        }

        // Cleanup Fall states
        vector<string> to_remove_fall;
        for (auto const& [key, state] : person_fall_state) {
            if (key.rfind(to_string(stream_id) + "_", 0) == 0) {
                if (now_ts - state.last_seen > FALL_GRACE_SEC) {
                    to_remove_fall.push_back(key);
                }
            }
        }
        for (const auto& k : to_remove_fall) {
            person_fall_state.erase(k);
        }
    }
    return GST_PAD_PROBE_OK;
}

static void cb_newpad(GstElement *decodebin, GstPad *decoder_src_pad, gpointer data) {
    GstCaps *caps = gst_pad_get_current_caps(decoder_src_pad);
    if (!caps) return;
    
    GstStructure *gststruct = gst_caps_get_structure(caps, 0);
    const gchar *gstname = gst_structure_get_name(gststruct);
    GstElement *source_bin = (GstElement *)data;
    GstCapsFeatures *features = gst_caps_get_features(caps, 0);

    if (g_strrstr(gstname, "video") != NULL) {
        if (gst_caps_features_contains(features, "memory:NVMM")) {
            GstPad *bin_ghost_pad = gst_element_get_static_pad(source_bin, "src");
            if (!gst_ghost_pad_set_target(GST_GHOST_PAD(bin_ghost_pad), decoder_src_pad)) {
                g_printerr("Failed to link decoder src pad to ghost pad\n");
            }
            gst_object_unref(bin_ghost_pad);
        }
    }
    gst_caps_unref(caps);
}

static void decodebin_child_added(GstChildProxy *child_proxy, GObject *object, gchar *name, gpointer user_data) {
    if (g_strrstr(name, "decodebin") != NULL) {
        g_signal_connect(G_OBJECT(object), "child-added", G_CALLBACK(decodebin_child_added), user_data);
    }
    if (g_strrstr(name, "source") != NULL) {
        GObject *source_element = NULL;
        g_object_get(child_proxy, "source", &source_element, NULL);
        if (source_element) {
            g_object_set(source_element, "drop-on-latency", TRUE, NULL);
            g_object_set(source_element, "protocols", 4, NULL);
        }
    }
}

static GstElement *create_source_bin(int index, const char *uri) {
    gchar bin_name[16];
    g_snprintf(bin_name, 15, "source-bin-%02d", index);
    GstElement *nbin = gst_bin_new(bin_name);
    
    GstElement *uri_decode_bin = gst_element_factory_make("uridecodebin", "uri-decode-bin");
    g_object_set(G_OBJECT(uri_decode_bin), "uri", uri, NULL);
    g_signal_connect(G_OBJECT(uri_decode_bin), "pad-added", G_CALLBACK(cb_newpad), nbin);
    g_signal_connect(G_OBJECT(uri_decode_bin), "child-added", G_CALLBACK(decodebin_child_added), nbin);

    gst_bin_add(GST_BIN(nbin), uri_decode_bin);
    GstPad *bin_pad = gst_ghost_pad_new_no_target("src", GST_PAD_SRC);
    gst_element_add_pad(nbin, bin_pad);
    return nbin;
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        g_printerr("Usage: %s <uri1> [uri2] ...\n", argv[0]);
        return -1;
    }

    int num_sources = argc - 1;

    gst_init(&argc, &argv);

    char abs_path[PATH_MAX];
    if (realpath("../../config.ini", abs_path) == NULL) {
        g_printerr("Error resolving config.ini path\n");
        return -1;
    }

    GKeyFile *key_file = g_key_file_new();
    GError *error = NULL;
    if (!g_key_file_load_from_file(key_file, abs_path, G_KEY_FILE_NONE, &error)) {
        g_printerr("Error loading config.ini: %s\n", error->message);
        g_error_free(error);
        return -1;
    }

    char root_path[PATH_MAX];
    realpath("../../", root_path);
    string project_root = string(root_path);

    gchar *db_host = g_key_file_get_string(key_file, "Database", "MONGO_HOST", NULL);
    gchar *db_port = g_key_file_get_string(key_file, "Database", "MONGO_PORT", NULL);
    gchar *db_user = g_key_file_get_string(key_file, "Database", "MONGO_APP_USER", NULL);
    gchar *db_pass = g_key_file_get_string(key_file, "Database", "MONGO_APP_PASS", NULL);
    gchar *db_name = g_key_file_get_string(key_file, "Database", "DB_NAME", NULL);
    gchar *events_col = g_key_file_get_string(key_file, "Database", "EVENTS_COLLECTION", NULL);

    gchar *escaped_user = g_uri_escape_string(db_user, NULL, TRUE);
    gchar *escaped_pass = g_uri_escape_string(db_pass, NULL, TRUE);
    gchar *uri = g_strdup_printf("mongodb://%s:%s@%s:%s/?authSource=admin", escaped_user, escaped_pass, db_host, db_port);
    g_free(escaped_user);
    g_free(escaped_pass);

    gchar *conf_folder_rel = g_key_file_get_string(key_file, "Paths", "DATA_DIR", NULL);
    if (conf_folder_rel) {
        folder_name = project_root + "/" + string(conf_folder_rel);
        
        string rel_str = string(conf_folder_rel);
        size_t pos = rel_str.find("AI_Pipeline/");
        if (pos != string::npos) {
            db_folder_name = "/" + rel_str.substr(pos + 12);
        } else {
            size_t slash_pos = rel_str.find_last_of("/");
            if (slash_pos != string::npos) {
                db_folder_name = "/" + rel_str.substr(slash_pos + 1);
            } else {
                db_folder_name = "/" + rel_str;
            }
        }
        g_free(conf_folder_rel);
    }

    DWELL_GRACE_SEC = g_key_file_get_double(key_file, "AI", "DWELL_GRACE_SEC", NULL);
    FALL_RECOVERY_SEC = g_key_file_get_double(key_file, "AI", "FALL_RECOVERY_SEC", NULL);
    FALL_TRIGGER_SEC = g_key_file_get_double(key_file, "AI", "FALL_TRIGGER_SEC", NULL);
    FALL_GRACE_SEC = g_key_file_get_double(key_file, "AI", "FALL_GRACE_SEC", NULL);

    MUXER_OUTPUT_WIDTH = g_key_file_get_integer(key_file, "AI", "MUXER_OUTPUT_WIDTH", NULL);
    MUXER_OUTPUT_HEIGHT = g_key_file_get_integer(key_file, "AI", "MUXER_OUTPUT_HEIGHT", NULL);

    gchar *infer_config_rel = g_key_file_get_string(key_file, "Paths", "INFER_CONFIG", NULL);
    string infer_config = project_root + "/" + string(infer_config_rel);
    g_free(infer_config_rel);

    gchar *tracker_lib_rel = g_key_file_get_string(key_file, "Paths", "TRACKER_LIB", NULL);
    string tracker_lib = string(tracker_lib_rel);
    if (tracker_lib[0] != '/') {
        tracker_lib = project_root + "/" + tracker_lib;
    }
    g_free(tracker_lib_rel);

    gchar *tracker_config_rel = g_key_file_get_string(key_file, "Paths", "TRACKER_CONFIG", NULL);
    string tracker_config = project_root + "/" + string(tracker_config_rel);
    g_free(tracker_config_rel);

    gchar *analytics_config_rel = g_key_file_get_string(key_file, "Paths", "ANALYTICS_CONFIG", NULL);
    string analytics_config = project_root + "/" + string(analytics_config_rel);
    g_free(analytics_config_rel);

    mongoc_init();
    mongo_client = mongoc_client_new(uri);
    if (mongo_client) {
        mongo_collection = mongoc_client_get_collection(mongo_client, db_name, events_col);
    } else {
        g_printerr("Failed to connect to MongoDB\n");
    }



    GstElement *pipeline = gst_pipeline_new("deepstream-pipeline");
    GstElement *streammux = gst_element_factory_make("nvstreammux", "stream-muxer");
    gst_bin_add(GST_BIN(pipeline), streammux);

    for (int i = 0; i < num_sources; i++) {
        GstElement *source_bin = create_source_bin(i, argv[i + 1]);
        gst_bin_add(GST_BIN(pipeline), source_bin);
        
        gchar pad_name[16];
        g_snprintf(pad_name, 15, "sink_%u", i);
        GstPad *sinkpad = gst_element_request_pad_simple(streammux, pad_name);
        GstPad *srcpad = gst_element_get_static_pad(source_bin, "src");
        gst_pad_link(srcpad, sinkpad);
        gst_object_unref(srcpad);
        gst_object_unref(sinkpad);
    }

    GstElement *queue1 = gst_element_factory_make("queue", "queue1");
    GstElement *pgie = gst_element_factory_make("nvinfer", "primary-inference");
    GstElement *tracker = gst_element_factory_make("nvtracker", "tracker");
    GstElement *nvanalytics = gst_element_factory_make("nvdsanalytics", "analytics");
    GstElement *nvvidconv = gst_element_factory_make("nvvideoconvert", "convertor");
    GstElement *filter1 = gst_element_factory_make("capsfilter", "filter1");
    GstElement *fakesink = gst_element_factory_make("fakesink", "fakesink");

    g_object_set(G_OBJECT(streammux), "width", MUXER_OUTPUT_WIDTH, "height", MUXER_OUTPUT_HEIGHT, "batch-size", num_sources, "batched-push-timeout", MUXER_BATCH_TIMEOUT_USEC, NULL);
    g_object_set(G_OBJECT(streammux), "live-source", 1, NULL);
    
    // Unified Memory configuration on Jetson (4)
    g_object_set(G_OBJECT(streammux), "nvbuf-memory-type", 4, NULL);
    g_object_set(G_OBJECT(nvvidconv), "nvbuf-memory-type", 4, NULL);

    g_object_set(G_OBJECT(pgie), "config-file-path", infer_config.c_str(), NULL);
    
    g_object_set(G_OBJECT(tracker), "ll-lib-file", tracker_lib.c_str(), NULL);
    g_object_set(G_OBJECT(tracker), "ll-config-file", tracker_config.c_str(), NULL);
    g_object_set(G_OBJECT(tracker), "tracker-width", 640, "tracker-height", 384, NULL);

    // Dynamic config path
    g_object_set(G_OBJECT(nvanalytics), "config-file", analytics_config.c_str(), NULL);
    
    GstCaps *caps1 = gst_caps_from_string("video/x-raw(memory:NVMM), format=RGBA");
    g_object_set(G_OBJECT(filter1), "caps", caps1, NULL);
    gst_caps_unref(caps1);
    
    g_object_set(G_OBJECT(fakesink), "sync", FALSE, NULL);

    gst_bin_add_many(GST_BIN(pipeline), queue1, pgie, tracker, nvanalytics, nvvidconv, filter1, fakesink, NULL);
    
    gst_element_link_many(streammux, queue1, pgie, tracker, nvanalytics, nvvidconv, filter1, fakesink, NULL);

    GstPad *pgie_src_pad = gst_element_get_static_pad(filter1, "sink");
    gst_pad_add_probe(pgie_src_pad, GST_PAD_PROBE_TYPE_BUFFER, pgie_src_pad_buffer_probe, NULL, NULL);
    gst_object_unref(pgie_src_pad);

    g_print("Now playing...\n");
    gst_element_set_state(pipeline, GST_STATE_PLAYING);
    
    GMainLoop *loop = g_main_loop_new(NULL, FALSE);
    g_main_loop_run(loop);
    
    gst_element_set_state(pipeline, GST_STATE_NULL);
    gst_object_unref(pipeline);
    g_main_loop_unref(loop);

    if (mongo_collection) mongoc_collection_destroy(mongo_collection);
    if (mongo_client) mongoc_client_destroy(mongo_client);
    mongoc_cleanup();

    g_free(db_host);
    g_free(db_port);
    g_free(db_user);
    g_free(db_pass);
    g_free(db_name);
    g_free(events_col);
    g_free(uri);
    g_key_file_free(key_file);

    return 0;
}
