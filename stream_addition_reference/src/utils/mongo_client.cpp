#include "mongo_client.h"
#include "logger.h"
#include <iostream>
#include <cstring>
#include <crypt.h>
#include <sstream>

bool MongoClient::init(const std::string& uri) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (initialized) return true;

    mongoc_init();
    uri_str = uri;

    bson_error_t error;
    mongoc_uri_t* m_uri = mongoc_uri_new_with_error(uri.c_str(), &error);
    if (!m_uri) {
        LOG_HEALTH(ERROR, "db.mongo", "HLTH-030", std::string("Invalid URI: ") + error.message);
        return false;
    }

    client = mongoc_client_new_from_uri(m_uri);
    mongoc_uri_destroy(m_uri);

    if (!client) {
        LOG_HEALTH(ERROR, "db.mongo", "HLTH-030", "Failed to create MongoDB client");
        return false;
    }

    mongoc_client_set_appname(client, "smartentry");

    if (ping()) {
        LOG_HEALTH(INFO, "db.mongo", "HLTH-031", "MongoDB connected successfully");
        initialized = true;
        return true;
    } else {
        LOG_HEALTH(WARN, "db.mongo", "HLTH-051", "MongoDB ping failed on init");
        // Keep client alive — connection may recover
        initialized = true;
        return true;
    }
}

void MongoClient::cleanup() {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (client) {
        mongoc_client_destroy(client);
        client = nullptr;
    }
    if (initialized) {
        mongoc_cleanup();
        initialized = false;
    }
}

bool MongoClient::ping() {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return false;
    bson_t* cmd = BCON_NEW("ping", BCON_INT32(1));
    bson_t reply;
    bson_error_t error;
    bool ok = mongoc_client_command_simple(client, "admin", cmd, nullptr, &reply, &error);
    bson_destroy(cmd);
    bson_destroy(&reply);
    if (!ok) {
        LOG_HEALTH(WARN, "db.mongo", "HLTH-051", std::string("MongoDB ping failed: ") + error.message);
    }
    return ok;
}

std::string MongoClient::authenticateUser(const std::string& username, const std::string& password) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return "";

    mongoc_collection_t* coll = mongoc_client_get_collection(client, "global_db", "users");
    bson_t* query = BCON_NEW("username", BCON_UTF8(username.c_str()));
    mongoc_cursor_t* cursor = mongoc_collection_find_with_opts(coll, query, nullptr, nullptr);

    std::string db_name;
    const bson_t* doc;
    if (mongoc_cursor_next(cursor, &doc)) {
        bson_iter_t iter;
        std::string stored_hash;
        if (bson_iter_init_find(&iter, doc, "password") && BSON_ITER_HOLDS_UTF8(&iter)) {
            stored_hash = bson_iter_utf8(&iter, nullptr);
        }
        if (bson_iter_init_find(&iter, doc, "db_name") && BSON_ITER_HOLDS_UTF8(&iter)) {
            db_name = bson_iter_utf8(&iter, nullptr);
        }

        // Verify bcrypt password
        if (!stored_hash.empty()) {
            char* result = crypt(password.c_str(), stored_hash.c_str());
            if (result && strcmp(result, stored_hash.c_str()) == 0) {
                LOG_AUTH(INFO, "auth.mongo", "AUTH-001", "MongoDB auth successful for: " + username);
            } else {
                LOG_AUTH(WARN, "auth.mongo", "AUTH-002", "MongoDB auth failed for: " + username);
                db_name.clear();
            }
        } else {
            db_name.clear();
        }
    } else {
        LOG_AUTH(WARN, "auth.mongo", "AUTH-002", "User not found in MongoDB: " + username);
    }

    mongoc_cursor_destroy(cursor);
    bson_destroy(query);
    mongoc_collection_destroy(coll);
    return db_name;
}

bool MongoClient::updateUserPassword(const std::string& username, const std::string& new_password) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return false;

    char salt[32] = "$2b$12$";
    const char* base64_abc = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for(int i=0; i<16; i++) salt[7+i] = base64_abc[rand() % 64];
    salt[23] = '\0';

    char* hash = crypt(new_password.c_str(), salt);
    if (!hash) return false;

    mongoc_collection_t* coll = mongoc_client_get_collection(client, "admin", "users");
    
    bson_t* query = BCON_NEW("username", BCON_UTF8(username.c_str()));
    bson_t* update = BCON_NEW("$set", "{", "password", BCON_UTF8(hash), "}");

    bson_error_t error;
    bool ok = mongoc_collection_update_one(coll, query, update, nullptr, nullptr, &error);
    if (!ok) {
        LOG_HEALTH(ERROR, "auth.mongo", "AUTH-050", std::string("Failed to update password: ") + error.message);
    }

    bson_destroy(query);
    bson_destroy(update);
    mongoc_collection_destroy(coll);
    return ok;
}

std::vector<MongoStream> MongoClient::getStreams(const std::string& db_name) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    std::vector<MongoStream> result;
    if (!client) return result;

    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "streams");
    bson_t* query = bson_new();
    bson_t* opts = BCON_NEW("sort", "{", "order_index", BCON_INT32(1), "}");
    mongoc_cursor_t* cursor = mongoc_collection_find_with_opts(coll, query, opts, nullptr);

    const bson_t* doc;
    while (mongoc_cursor_next(cursor, &doc)) {
        MongoStream s = {};
        bson_iter_t iter;
        if (bson_iter_init_find(&iter, doc, "stream_id")) s.stream_id = bson_iter_as_int64(&iter);
        if (bson_iter_init_find(&iter, doc, "rtsp_url") && BSON_ITER_HOLDS_UTF8(&iter))
            s.rtsp_url = bson_iter_utf8(&iter, nullptr);
        if (bson_iter_init_find(&iter, doc, "webrtc_url") && BSON_ITER_HOLDS_UTF8(&iter))
            s.webrtc_url = bson_iter_utf8(&iter, nullptr);
        if (bson_iter_init_find(&iter, doc, "order_index")) s.order_index = bson_iter_as_int64(&iter);
        result.push_back(s);
    }

    LOG_HEALTH(INFO, "db.mongo", "HLTH-053", "Loaded " + std::to_string(result.size()) + " streams from MongoDB");
    mongoc_cursor_destroy(cursor);
    bson_destroy(query);
    bson_destroy(opts);
    mongoc_collection_destroy(coll);
    return result;
}

bool MongoClient::updateStreamUrl(const std::string& db_name, int stream_id, const std::string& new_url) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return false;

    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "streams");

    bson_t* selector = BCON_NEW("stream_id", BCON_INT32(stream_id));
    bson_t* update = BCON_NEW(
        "$set", "{",
            "rtsp_url", BCON_UTF8(new_url.c_str()),
            "stream_id", BCON_INT32(stream_id),
            "order_index", BCON_INT32(stream_id),
        "}"
    );

    // Use upsert so new streams are inserted if they don't exist yet
    bson_t opts;
    bson_init(&opts);
    BSON_APPEND_BOOL(&opts, "upsert", true);

    bson_error_t error;
    bool ok = mongoc_collection_update_one(coll, selector, update, &opts, nullptr, &error);
    if (!ok) {
        LOG_HEALTH(ERROR, "db.mongo", "HLTH-056", std::string("Failed to upsert stream URL: ") + error.message);
    }

    bson_destroy(&opts);
    bson_destroy(selector);
    bson_destroy(update);
    mongoc_collection_destroy(coll);
    return ok;
}

bool MongoClient::deleteStream(const std::string& db_name, int stream_id) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return false;
    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "streams");
    bson_t* selector = BCON_NEW("stream_id", BCON_INT32(stream_id));
    bson_error_t error;
    bool ok = mongoc_collection_delete_one(coll, selector, nullptr, nullptr, &error);
    bson_destroy(selector);
    mongoc_collection_destroy(coll);
    return ok;
}

void MongoClient::deleteExcessStreams(const std::string& db_name, int keep_count) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return;
    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "streams");
    bson_t* selector = BCON_NEW("stream_id", "{", "$gte", BCON_INT32(keep_count), "}");
    bson_error_t error;
    mongoc_collection_delete_many(coll, selector, nullptr, nullptr, &error);
    bson_destroy(selector);
    mongoc_collection_destroy(coll);

    // Remove ROI and Line crossings from client_configs
    mongoc_collection_t* config_coll = mongoc_client_get_collection(client, db_name.c_str(), "client_configs");
    bson_t* config_query = BCON_NEW("config_name", BCON_UTF8("client_app_config"));
    
    bson_t* update = bson_new();
    bson_t unset_doc;
    BSON_APPEND_DOCUMENT_BEGIN(update, "$unset", &unset_doc);
    for (int i = keep_count; i < 20; i++) {
        std::string roi_key = "data.roi-filtering-stream-" + std::to_string(i);
        std::string line_key = "data.line-crossing-stream-" + std::to_string(i);
        BSON_APPEND_UTF8(&unset_doc, roi_key.c_str(), "");
        BSON_APPEND_UTF8(&unset_doc, line_key.c_str(), "");
    }
    bson_append_document_end(update, &unset_doc);
    
    mongoc_collection_update_one(config_coll, config_query, update, nullptr, nullptr, nullptr);
    bson_destroy(update);

    // Rebuild raw_text based on the updated data object
    mongoc_cursor_t* cursor = mongoc_collection_find_with_opts(config_coll, config_query, nullptr, nullptr);
    const bson_t* doc;
    if (mongoc_cursor_next(cursor, &doc)) {
        bson_iter_t iter;
        if (bson_iter_init_find(&iter, doc, "data") && BSON_ITER_HOLDS_DOCUMENT(&iter)) {
            bson_iter_t data_iter;
            bson_iter_recurse(&iter, &data_iter);
            
            std::string raw_text = "";
            while (bson_iter_next(&data_iter)) {
                if (BSON_ITER_HOLDS_DOCUMENT(&data_iter)) {
                    std::string section_name = bson_iter_key(&data_iter);
                    raw_text += "[" + section_name + "]\n";
                    
                    bson_iter_t sub_iter;
                    bson_iter_recurse(&data_iter, &sub_iter);
                    while (bson_iter_next(&sub_iter)) {
                        std::string k = bson_iter_key(&sub_iter);
                        if (BSON_ITER_HOLDS_UTF8(&sub_iter)) {
                            std::string v = bson_iter_utf8(&sub_iter, nullptr);
                            raw_text += k + " = " + v + "\n";
                        }
                    }
                    raw_text += "\n";
                }
            }
            
            bson_t* update_raw = bson_new();
            bson_t set_raw;
            BSON_APPEND_DOCUMENT_BEGIN(update_raw, "$set", &set_raw);
            BSON_APPEND_UTF8(&set_raw, "raw_text", raw_text.c_str());
            bson_append_document_end(update_raw, &set_raw);
            
            mongoc_collection_update_one(config_coll, config_query, update_raw, nullptr, nullptr, nullptr);
            bson_destroy(update_raw);
        }
    }
    mongoc_cursor_destroy(cursor);
    bson_destroy(config_query);
    mongoc_collection_destroy(config_coll);
}

void MongoClient::parseCapturedImage(const bson_t* doc, MongoCapturedImage& img) {
    bson_iter_t iter;

    if (bson_iter_init_find(&iter, doc, "_id") && BSON_ITER_HOLDS_OID(&iter)) {
        char oid_str[25];
        bson_oid_to_string(bson_iter_oid(&iter), oid_str);
        img.id = oid_str;
    }
    if (bson_iter_init_find(&iter, doc, "event_type") && BSON_ITER_HOLDS_UTF8(&iter))
        img.event_type = bson_iter_utf8(&iter, nullptr);
    if (bson_iter_init_find(&iter, doc, "area_name") && BSON_ITER_HOLDS_UTF8(&iter))
        img.area_name = bson_iter_utf8(&iter, nullptr);
    if (bson_iter_init_find(&iter, doc, "object_id"))
        img.object_id = bson_iter_as_int64(&iter);
    if (bson_iter_init_find(&iter, doc, "stream_id"))
        img.stream_id = bson_iter_as_int64(&iter);
    if (bson_iter_init_find(&iter, doc, "class_id"))
        img.class_id = bson_iter_as_int64(&iter);
    if (bson_iter_init_find(&iter, doc, "frame_number"))
        img.frame_number = bson_iter_as_int64(&iter);
    if (bson_iter_init_find(&iter, doc, "image_path") && BSON_ITER_HOLDS_UTF8(&iter))
        img.image_path = bson_iter_utf8(&iter, nullptr);
    if (bson_iter_init_find(&iter, doc, "date") && BSON_ITER_HOLDS_UTF8(&iter))
        img.date = bson_iter_utf8(&iter, nullptr);
    if (bson_iter_init_find(&iter, doc, "time") && BSON_ITER_HOLDS_UTF8(&iter))
        img.time = bson_iter_utf8(&iter, nullptr);
    if (bson_iter_init_find(&iter, doc, "is_verified")) {
        if (BSON_ITER_HOLDS_BOOL(&iter))
            img.is_verified = bson_iter_bool(&iter);
        else
            img.is_verified = bson_iter_as_int64(&iter) != 0;
    }
}

std::vector<MongoCapturedImage> MongoClient::getCapturedImages(const std::string& db_name, int limit, const std::string& since_id, const std::string& before_id, const std::string& date_gte) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    std::vector<MongoCapturedImage> result;
    if (!client) return result;

    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "captured_images");
    bson_t* query = bson_new();
    
    if (!since_id.empty() || !before_id.empty()) {
        bson_t child;
        BSON_APPEND_DOCUMENT_BEGIN(query, "_id", &child);
        if (!since_id.empty() && bson_oid_is_valid(since_id.c_str(), since_id.length())) {
            bson_oid_t oid;
            bson_oid_init_from_string(&oid, since_id.c_str());
            BSON_APPEND_OID(&child, "$gt", &oid);
        }
        if (!before_id.empty() && bson_oid_is_valid(before_id.c_str(), before_id.length())) {
            bson_oid_t oid;
            bson_oid_init_from_string(&oid, before_id.c_str());
            BSON_APPEND_OID(&child, "$lt", &oid);
        }
        bson_append_document_end(query, &child);
    }

    if (!date_gte.empty()) {
        bson_t child;
        BSON_APPEND_DOCUMENT_BEGIN(query, "date", &child);
        BSON_APPEND_UTF8(&child, "$gte", date_gte.c_str());
        bson_append_document_end(query, &child);
    }

    bson_t* opts = BCON_NEW(
        "sort", "{", "_id", BCON_INT32(-1), "}",
        "limit", BCON_INT64((int64_t)limit)
    );
    mongoc_cursor_t* cursor = mongoc_collection_find_with_opts(coll, query, opts, nullptr);

    const bson_t* doc;
    while (mongoc_cursor_next(cursor, &doc)) {
        MongoCapturedImage img = {};
        parseCapturedImage(doc, img);
        result.push_back(img);
    }

    LOG_HEALTH(INFO, "db.mongo", "HLTH-054", "Loaded " + std::to_string(result.size()) + " captured images from MongoDB");
    mongoc_cursor_destroy(cursor);
    bson_destroy(query);
    bson_destroy(opts);
    mongoc_collection_destroy(coll);
    return result;
}

bool MongoClient::getCapturedImageById(const std::string& db_name, const std::string& img_id, MongoCapturedImage& out_img) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return false;

    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "captured_images");

    bson_oid_t oid;
    if (!bson_oid_is_valid(img_id.c_str(), img_id.length())) {
        mongoc_collection_destroy(coll);
        return false;
    }
    bson_oid_init_from_string(&oid, img_id.c_str());
    bson_t* query = BCON_NEW("_id", BCON_OID(&oid));

    mongoc_cursor_t* cursor = mongoc_collection_find_with_opts(coll, query, nullptr, nullptr);
    const bson_t* doc;
    bool found = false;
    if (mongoc_cursor_next(cursor, &doc)) {
        out_img = {};
        parseCapturedImage(doc, out_img);
        found = true;
    }

    mongoc_cursor_destroy(cursor);
    bson_destroy(query);
    mongoc_collection_destroy(coll);
    return found;
}

void MongoClient::getDailyEventStats(const std::string& db_name, const std::string& date_str, int& out_total, int& out_verified, int& out_pending) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    out_total = 0;
    out_verified = 0;
    out_pending = 0;
    if (!client) return;

    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "captured_images");
    
    // Count total
    bson_t* q_total = BCON_NEW("date", BCON_UTF8(date_str.c_str()));
    int64_t total_c = mongoc_collection_count_documents(coll, q_total, nullptr, nullptr, nullptr, nullptr);
    if (total_c > 0) out_total = (int)total_c;
    bson_destroy(q_total);

    // Count verified
    bson_t* q_ver = BCON_NEW("date", BCON_UTF8(date_str.c_str()), "is_verified", BCON_BOOL(true));
    int64_t ver_c = mongoc_collection_count_documents(coll, q_ver, nullptr, nullptr, nullptr, nullptr);
    if (ver_c > 0) out_verified = (int)ver_c;
    bson_destroy(q_ver);

    // Calculate pending
    out_pending = out_total - out_verified;
    if (out_pending < 0) out_pending = 0;

    mongoc_collection_destroy(coll);
}

int MongoClient::getEventCountByShape(const std::string& db_name, const std::string& area_name, int stream_id) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client || db_name.empty()) return 0;
    
    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "captured_images");
    
    bson_t* query = BCON_NEW(
        "area_name", BCON_UTF8(area_name.c_str()),
        "stream_id", BCON_INT32(stream_id)
    );
    
    bson_error_t error;
    int64_t count = mongoc_collection_count_documents(coll, query, nullptr, nullptr, nullptr, &error);
    
    bson_destroy(query);
    mongoc_collection_destroy(coll);
    
    return count > 0 ? (int)count : 0;
}

bool MongoClient::updateCapturedImage(const std::string& db_name, const MongoCapturedImage& img) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return false;

    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "captured_images");

    bson_oid_t oid;
    if (!bson_oid_is_valid(img.id.c_str(), img.id.length())) {
        mongoc_collection_destroy(coll);
        return false;
    }
    bson_oid_init_from_string(&oid, img.id.c_str());

    bson_t* selector = BCON_NEW("_id", BCON_OID(&oid));
    bson_t* update = BCON_NEW(
        "$set", "{",
            "is_verified", BCON_BOOL(img.is_verified),
        "}"
    );

    bson_error_t error;
    bool ok = mongoc_collection_update_one(coll, selector, update, nullptr, nullptr, &error);
    if (!ok) {
        LOG_HEALTH(ERROR, "db.mongo", "HLTH-055", std::string("Update failed: ") + error.message);
    }

    bson_destroy(selector);
    bson_destroy(update);
    mongoc_collection_destroy(coll);
    return ok;
}

bool MongoClient::deleteCapturedImage(const std::string& db_name, const std::string& img_id) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return false;

    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "captured_images");

    bson_oid_t oid;
    if (!bson_oid_is_valid(img_id.c_str(), img_id.length())) {
        mongoc_collection_destroy(coll);
        return false;
    }
    bson_oid_init_from_string(&oid, img_id.c_str());

    bson_t* selector = BCON_NEW("_id", BCON_OID(&oid));

    bson_error_t error;
    bool ok = mongoc_collection_delete_one(coll, selector, nullptr, nullptr, &error);
    if (!ok) {
        LOG_HEALTH(ERROR, "db.mongo", "HLTH-058", std::string("Failed to delete captured image: ") + error.message);
    }

    bson_destroy(selector);
    mongoc_collection_destroy(coll);
    return ok;
}

MongoAnalyticsConfig MongoClient::getAnalyticsConfig(const std::string& db_name, int stream_id) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    MongoAnalyticsConfig cfg;
    cfg.stream_id = stream_id;
    cfg.config_width = 1280;
    cfg.config_height = 720;
    
    if (!client) return cfg;

    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "client_configs");
    bson_t* query = BCON_NEW("config_name", BCON_UTF8("client_app_config"));

    mongoc_cursor_t* cursor = mongoc_collection_find_with_opts(coll, query, nullptr, nullptr);
    const bson_t* doc;
    if (mongoc_cursor_next(cursor, &doc)) {
        bson_iter_t iter;
        if (bson_iter_init_find(&iter, doc, "data") && BSON_ITER_HOLDS_DOCUMENT(&iter)) {
            bson_iter_t data_iter;
            bson_iter_recurse(&iter, &data_iter);
            
            // Try to find property width/height
            if (bson_iter_find(&data_iter, "property") && BSON_ITER_HOLDS_DOCUMENT(&data_iter)) {
                bson_iter_t prop_iter;
                bson_iter_recurse(&data_iter, &prop_iter);
                if (bson_iter_find(&prop_iter, "config-width") && BSON_ITER_HOLDS_UTF8(&prop_iter)) {
                    try { cfg.config_width = std::stoi(bson_iter_utf8(&prop_iter, nullptr)); } catch(...) {}
                }
                bson_iter_recurse(&data_iter, &prop_iter);
                if (bson_iter_find(&prop_iter, "config-height") && BSON_ITER_HOLDS_UTF8(&prop_iter)) {
                    try { cfg.config_height = std::stoi(bson_iter_utf8(&prop_iter, nullptr)); } catch(...) {}
                }
            }
            
            // Re-init data_iter for ROI search
            bson_iter_recurse(&iter, &data_iter);
            std::string roi_key = "roi-filtering-stream-" + std::to_string(stream_id);
            if (bson_iter_find(&data_iter, roi_key.c_str()) && BSON_ITER_HOLDS_DOCUMENT(&data_iter)) {
                bson_iter_t r_iter;
                bson_iter_recurse(&data_iter, &r_iter);
                while (bson_iter_next(&r_iter)) {
                    std::string key = bson_iter_key(&r_iter);
                    if (key.find("roi-") == 0 && BSON_ITER_HOLDS_UTF8(&r_iter)) {
                        MongoAnalyticsROI roi;
                        roi.name = key.substr(4);
                        std::string val = bson_iter_utf8(&r_iter, nullptr);
                        std::stringstream ss(val);
                        std::string token;
                        while (std::getline(ss, token, ';')) {
                            try { roi.coords.push_back(std::stoi(token)); } catch(...) {}
                        }
                        cfg.rois.push_back(roi);
                    }
                }
            }

            // Re-init data_iter for Lines search
            bson_iter_recurse(&iter, &data_iter);
            std::string line_key = "line-crossing-stream-" + std::to_string(stream_id);
            if (bson_iter_find(&data_iter, line_key.c_str()) && BSON_ITER_HOLDS_DOCUMENT(&data_iter)) {
                bson_iter_t l_iter;
                bson_iter_recurse(&data_iter, &l_iter);
                while (bson_iter_next(&l_iter)) {
                    std::string key = bson_iter_key(&l_iter);
                    if (key.find("line-crossing-") == 0 && BSON_ITER_HOLDS_UTF8(&l_iter)) {
                        MongoAnalyticsLine line;
                        line.name = key.substr(14);
                        std::string val = bson_iter_utf8(&l_iter, nullptr);
                        std::stringstream ss(val);
                        std::string token;
                        while (std::getline(ss, token, ';')) {
                            try { line.coords.push_back(std::stoi(token)); } catch(...) {}
                        }
                        cfg.lines.push_back(line);
                    }
                }
            }
        }
    }

    mongoc_cursor_destroy(cursor);
    bson_destroy(query);
    mongoc_collection_destroy(coll);
    return cfg;
}

bool MongoClient::updateAnalyticsConfig(const std::string& db_name, const MongoAnalyticsConfig& config) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return false;
    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "client_configs");

    bson_t* query = BCON_NEW("config_name", BCON_UTF8("client_app_config"));
    
    bson_t* update = bson_new();
    bson_t set_doc;
    BSON_APPEND_DOCUMENT_BEGIN(update, "$set", &set_doc);

    std::string roi_key = "data.roi-filtering-stream-" + std::to_string(config.stream_id);
    std::string line_key = "data.line-crossing-stream-" + std::to_string(config.stream_id);

    bson_t roi_doc;
    BSON_APPEND_DOCUMENT_BEGIN(&set_doc, roi_key.c_str(), &roi_doc);
    BSON_APPEND_UTF8(&roi_doc, "enable", "1");
    BSON_APPEND_UTF8(&roi_doc, "inverse-roi", "0");
    BSON_APPEND_UTF8(&roi_doc, "class-id", "0");
    for (const auto& roi : config.rois) {
        std::string key = "roi-" + roi.name;
        std::string val = "";
        for (size_t i = 0; i < roi.coords.size(); i++) {
            val += std::to_string(roi.coords[i]);
            if (i < roi.coords.size() - 1) val += ";";
        }
        BSON_APPEND_UTF8(&roi_doc, key.c_str(), val.c_str());
    }
    bson_append_document_end(&set_doc, &roi_doc);

    bson_t line_doc;
    BSON_APPEND_DOCUMENT_BEGIN(&set_doc, line_key.c_str(), &line_doc);
    BSON_APPEND_UTF8(&line_doc, "enable", "1");
    BSON_APPEND_UTF8(&line_doc, "mode", "loose");
    BSON_APPEND_UTF8(&line_doc, "class-id", "0");
    BSON_APPEND_UTF8(&line_doc, "extended", "0");
    for (const auto& line : config.lines) {
        std::string key = "line-crossing-" + line.name;
        std::string val = "";
        for (size_t i = 0; i < line.coords.size(); i++) {
            val += std::to_string(line.coords[i]);
            if (i < line.coords.size() - 1) val += ";";
        }
        BSON_APPEND_UTF8(&line_doc, key.c_str(), val.c_str());
    }
    bson_append_document_end(&set_doc, &line_doc);

    bson_append_document_end(update, &set_doc);

    bson_t* opts = BCON_NEW("upsert", BCON_BOOL(true));
    bson_error_t error;
    bool ok = mongoc_collection_update_one(coll, query, update, opts, nullptr, &error);
    if (!ok) {
        LOG_HEALTH(ERROR, "db.mongo", "HLTH-057", std::string("Analytics Config update failed: ") + error.message);
    }
    bson_destroy(update);

    // Rebuild raw_text based on the updated data object
    mongoc_cursor_t* cursor = mongoc_collection_find_with_opts(coll, query, nullptr, nullptr);
    const bson_t* doc;
    if (mongoc_cursor_next(cursor, &doc)) {
        bson_iter_t iter;
        if (bson_iter_init_find(&iter, doc, "data") && BSON_ITER_HOLDS_DOCUMENT(&iter)) {
            bson_iter_t data_iter;
            bson_iter_recurse(&iter, &data_iter);
            
            std::string raw_text = "";
            while (bson_iter_next(&data_iter)) {
                if (BSON_ITER_HOLDS_DOCUMENT(&data_iter)) {
                    std::string section_name = bson_iter_key(&data_iter);
                    raw_text += "[" + section_name + "]\n";
                    
                    bson_iter_t sub_iter;
                    bson_iter_recurse(&data_iter, &sub_iter);
                    while (bson_iter_next(&sub_iter)) {
                        std::string k = bson_iter_key(&sub_iter);
                        if (BSON_ITER_HOLDS_UTF8(&sub_iter)) {
                            std::string v = bson_iter_utf8(&sub_iter, nullptr);
                            raw_text += k + " = " + v + "\n";
                        }
                    }
                    raw_text += "\n";
                }
            }
            
            bson_t* update_raw = bson_new();
            bson_t set_raw;
            BSON_APPEND_DOCUMENT_BEGIN(update_raw, "$set", &set_raw);
            BSON_APPEND_UTF8(&set_raw, "raw_text", raw_text.c_str());
            bson_append_document_end(update_raw, &set_raw);
            
            mongoc_collection_update_one(coll, query, update_raw, nullptr, nullptr, nullptr);
            bson_destroy(update_raw);
        }
    }
    mongoc_cursor_destroy(cursor);

    bson_destroy(query);
    bson_destroy(opts);
    mongoc_collection_destroy(coll);
    return ok;
}

std::vector<std::string> MongoClient::getDistinctEventTypes(const std::string& db_name) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    std::vector<std::string> result;
    if (!client) return result;

    bson_t* cmd = BCON_NEW("distinct", BCON_UTF8("captured_images"), "key", BCON_UTF8("event_type"));
    bson_t reply;
    bson_error_t error;
    bool ok = mongoc_client_command_simple(client, db_name.c_str(), cmd, nullptr, &reply, &error);
    bson_destroy(cmd);

    if (ok) {
        bson_iter_t iter;
        bson_iter_t array_iter;
        if (bson_iter_init_find(&iter, &reply, "values") && BSON_ITER_HOLDS_ARRAY(&iter)) {
            if (bson_iter_recurse(&iter, &array_iter)) {
                while (bson_iter_next(&array_iter)) {
                    if (BSON_ITER_HOLDS_UTF8(&array_iter)) {
                        result.push_back(bson_iter_utf8(&array_iter, nullptr));
                    }
                }
            }
        }
        bson_destroy(&reply);
    } else {
        LOG_HEALTH(WARN, "db.mongo", "HLTH-051", std::string("Distinct event_type query failed: ") + error.message);
        bson_destroy(&reply);
    }
    
    // Default fallbacks if empty or query failed
    if (result.empty()) {
        result = {"roi_entry", "roi_exit", "roi_dwell", "line_cross", "intrusion", "fall_detection"};
    }
    return result;
}

std::string MongoClient::getAlarmConfig(const std::string& db_name) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    std::string enabled_events = "";
    if (!client) return enabled_events;

    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "client_configs");
    bson_t* query = BCON_NEW("config_name", BCON_UTF8("client_app_config"));

    mongoc_cursor_t* cursor = mongoc_collection_find_with_opts(coll, query, nullptr, nullptr);
    const bson_t* doc;
    if (mongoc_cursor_next(cursor, &doc)) {
        bson_iter_t iter;
        if (bson_iter_init_find(&iter, doc, "data") && BSON_ITER_HOLDS_DOCUMENT(&iter)) {
            bson_iter_t data_iter;
            bson_iter_recurse(&iter, &data_iter);
            
            if (bson_iter_find(&data_iter, "alarm") && BSON_ITER_HOLDS_DOCUMENT(&data_iter)) {
                bson_iter_t alarm_iter;
                bson_iter_recurse(&data_iter, &alarm_iter);
                if (bson_iter_find(&alarm_iter, "enabled_events") && BSON_ITER_HOLDS_UTF8(&alarm_iter)) {
                    enabled_events = bson_iter_utf8(&alarm_iter, nullptr);
                }
            }
        }
    }

    mongoc_cursor_destroy(cursor);
    bson_destroy(query);
    mongoc_collection_destroy(coll);
    return enabled_events;
}

bool MongoClient::updateAlarmConfig(const std::string& db_name, const std::string& enabled_events) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return false;
    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "client_configs");

    bson_t* query = BCON_NEW("config_name", BCON_UTF8("client_app_config"));
    
    bson_t* update = bson_new();
    bson_t set_doc;
    BSON_APPEND_DOCUMENT_BEGIN(update, "$set", &set_doc);

    bson_t alarm_doc;
    BSON_APPEND_DOCUMENT_BEGIN(&set_doc, "data.alarm", &alarm_doc);
    BSON_APPEND_UTF8(&alarm_doc, "enabled_events", enabled_events.c_str());
    bson_append_document_end(&set_doc, &alarm_doc);

    bson_append_document_end(update, &set_doc);

    bson_t* opts = BCON_NEW("upsert", BCON_BOOL(true));
    bson_error_t error;
    bool ok = mongoc_collection_update_one(coll, query, update, opts, nullptr, &error);
    if (!ok) {
        LOG_HEALTH(ERROR, "db.mongo", "HLTH-057", std::string("Alarm Config update failed: ") + error.message);
    }
    bson_destroy(update);

    // Rebuild raw_text based on the updated data object
    mongoc_cursor_t* cursor = mongoc_collection_find_with_opts(coll, query, nullptr, nullptr);
    const bson_t* doc;
    if (mongoc_cursor_next(cursor, &doc)) {
        bson_iter_t iter;
        if (bson_iter_init_find(&iter, doc, "data") && BSON_ITER_HOLDS_DOCUMENT(&iter)) {
            bson_iter_t data_iter;
            bson_iter_recurse(&iter, &data_iter);
            
            std::string raw_text = "";
            while (bson_iter_next(&data_iter)) {
                if (BSON_ITER_HOLDS_DOCUMENT(&data_iter)) {
                    std::string section_name = bson_iter_key(&data_iter);
                    raw_text += "[" + section_name + "]\n";
                    
                    bson_iter_t sub_iter;
                    bson_iter_recurse(&data_iter, &sub_iter);
                    while (bson_iter_next(&sub_iter)) {
                        std::string k = bson_iter_key(&sub_iter);
                        if (BSON_ITER_HOLDS_UTF8(&sub_iter)) {
                            std::string v = bson_iter_utf8(&sub_iter, nullptr);
                            raw_text += k + " = " + v + "\n";
                        }
                    }
                    raw_text += "\n";
                }
            }
            
            bson_t* update_raw = bson_new();
            bson_t set_raw;
            BSON_APPEND_DOCUMENT_BEGIN(update_raw, "$set", &set_raw);
            BSON_APPEND_UTF8(&set_raw, "raw_text", raw_text.c_str());
            bson_append_document_end(update_raw, &set_raw);
            
            mongoc_collection_update_one(coll, query, update_raw, nullptr, nullptr, nullptr);
            bson_destroy(update_raw);
        }
    }
    mongoc_cursor_destroy(cursor);

    bson_destroy(query);
    bson_destroy(opts);
    mongoc_collection_destroy(coll);
    return ok;
}

bool MongoClient::getLatestVLMData(const std::string& db_name, const std::string& stream_id, MongoVLMData& out_data) {
    std::lock_guard<std::recursive_mutex> lock(client_mutex);
    if (!client) return false;

    mongoc_collection_t* coll = mongoc_client_get_collection(client, db_name.c_str(), "vlm_analytics");
    bson_t* query = BCON_NEW("stream_id", BCON_UTF8(stream_id.c_str()));
    bson_t* opts = BCON_NEW(
        "sort", "{", "timestamp", BCON_INT32(-1), "}",
        "limit", BCON_INT64(1)
    );

    mongoc_cursor_t* cursor = mongoc_collection_find_with_opts(coll, query, opts, nullptr);
    const bson_t* doc;
    bool found = false;

    if (mongoc_cursor_next(cursor, &doc)) {
        found = true;
        out_data = MongoVLMData(); // Reset out_data
        out_data.stream_id = stream_id;

        bson_iter_t iter;
        
        if (bson_iter_init_find(&iter, doc, "_id") && BSON_ITER_HOLDS_OID(&iter)) {
            char oid_str[25];
            bson_oid_to_string(bson_iter_oid(&iter), oid_str);
            out_data.id = oid_str;
        }

        // timestamp is stored as ISODate (Date time) usually, or string.
        if (bson_iter_init_find(&iter, doc, "timestamp")) {
            if (BSON_ITER_HOLDS_DATE_TIME(&iter)) {
                // If it's a BSON date type we can format it, for now we will just set something generic if needed
                // It's safer to just let it be if it's a date object, or get it as string if stored as string.
                out_data.timestamp = "DateObject"; 
            } else if (BSON_ITER_HOLDS_UTF8(&iter)) {
                out_data.timestamp = bson_iter_utf8(&iter, nullptr);
            }
        }

        if (bson_iter_init_find(&iter, doc, "analysis") && BSON_ITER_HOLDS_DOCUMENT(&iter)) {
            bson_iter_t analysis_iter;
            bson_iter_recurse(&iter, &analysis_iter);

            if (bson_iter_find(&analysis_iter, "chaos") && BSON_ITER_HOLDS_BOOL(&analysis_iter)) {
                out_data.analysis.chaos = bson_iter_bool(&analysis_iter);
            }
            
            // Re-init for next fields
            bson_iter_recurse(&iter, &analysis_iter);
            if (bson_iter_find(&analysis_iter, "vehicles_count") && BSON_ITER_HOLDS_INT32(&analysis_iter)) {
                out_data.analysis.vehicles_count = bson_iter_int32(&analysis_iter);
            }

            bson_iter_recurse(&iter, &analysis_iter);
            if (bson_iter_find(&analysis_iter, "people_count") && BSON_ITER_HOLDS_INT32(&analysis_iter)) {
                out_data.analysis.people_count = bson_iter_int32(&analysis_iter);
            }

            bson_iter_recurse(&iter, &analysis_iter);
            if (bson_iter_find(&analysis_iter, "littering") && BSON_ITER_HOLDS_BOOL(&analysis_iter)) {
                out_data.analysis.littering = bson_iter_bool(&analysis_iter);
            }

            bson_iter_recurse(&iter, &analysis_iter);
            if (bson_iter_find(&analysis_iter, "public_issues") && BSON_ITER_HOLDS_DOCUMENT(&analysis_iter)) {
                bson_iter_t issues_iter;
                bson_iter_recurse(&analysis_iter, &issues_iter);
                
                if (bson_iter_find(&issues_iter, "has_issues") && BSON_ITER_HOLDS_BOOL(&issues_iter)) {
                    out_data.analysis.public_issues.has_issues = bson_iter_bool(&issues_iter);
                }

                bson_iter_recurse(&analysis_iter, &issues_iter);
                if (bson_iter_find(&issues_iter, "description") && BSON_ITER_HOLDS_UTF8(&issues_iter)) {
                    out_data.analysis.public_issues.description = bson_iter_utf8(&issues_iter, nullptr);
                }

                bson_iter_recurse(&analysis_iter, &issues_iter);
                if (bson_iter_find(&issues_iter, "severity") && BSON_ITER_HOLDS_UTF8(&issues_iter)) {
                    out_data.analysis.public_issues.severity = bson_iter_utf8(&issues_iter, nullptr);
                }
            }
        }
    }

    mongoc_cursor_destroy(cursor);
    bson_destroy(query);
    bson_destroy(opts);
    mongoc_collection_destroy(coll);
    return found;
}
