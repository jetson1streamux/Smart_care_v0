#include "settings_page.h"
#include "analytics_editor.h"
#include "../utils/config.h"
#include "../video_stream.h"
#include "../app.h"
#include "../utils/mongo_client.h"
#include "../utils/logger.h"
#include "../utils/mongo_client.h"
#include "../utils/image_loader.h"
#include <iostream>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>

#include <vector>
#include <fstream>
#include <streambuf>
#include <filesystem>
#include <regex>
#include <sstream>

struct SettingsNav {
    GtkWidget* scroll;
    GtkWidget* page;
    GtkWidget* nav_box;
    std::vector<std::pair<GtkWidget*, GtkWidget*>> sections;
};

struct SettingsState {
    GtkWidget* spin_stream_count;
    GtkWidget* urls_box;
    std::vector<GtkWidget*> url_entries;
    
    GtkWidget* e_cleanup;
    GtkWidget* e_limit;

    std::vector<std::pair<std::string, GtkWidget*>> alarm_checkboxes;

    GtkWidget* sec_entries[3];
    GtkWidget* sec_status;
    GtkWidget* btn_save;
    GtkWidget* save_status;
    SettingsNav nav;
    
    std::string loaded_db_name;
    GtkWidget* chk_box_container;
};

static void trigger_backend_restart() {
    std::string udp_ip = Config::getInstance().get("server", "backend_trigger_ip", "");
    std::string udp_port_str = Config::getInstance().get("server", "backend_trigger_port", "");
    int udp_port = udp_port_str.empty() ? 0 : std::stoi(udp_port_str);

    if (udp_ip.empty() || udp_port == 0) return;

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) {
        std::cerr << "❌ Socket creation failed" << std::endl;
        return;
    }

    struct sockaddr_in servaddr;
    std::memset(&servaddr, 0, sizeof(servaddr));
    
    servaddr.sin_family = AF_INET;
    servaddr.sin_port = htons(udp_port);
    servaddr.sin_addr.s_addr = inet_addr(udp_ip.c_str());

    const char* message = "RESTART";
    sendto(sock, message, std::strlen(message), 0, 
           (const struct sockaddr*)&servaddr, sizeof(servaddr));

    std::cout << "🚀 Sent restart trigger to Jetson at " << udp_ip << ":" << udp_port << std::endl;
    close(sock);
}

static void on_save_settings(GtkWidget* btn, gpointer data) {
    SettingsState* state = static_cast<SettingsState*>(data);

    gtk_label_set_text(GTK_LABEL(state->save_status), "");
    gtk_widget_remove_css_class(state->save_status, "text-rose");

    int count = gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(state->spin_stream_count));
    
    std::regex url_regex("^(rtsp|http|https|webrtc)://([a-zA-Z0-9\\-._~%]+:[a-zA-Z0-9\\-._~%]+@)?([a-zA-Z0-9\\-._]+)(:[0-9]+)?(/.*)?$");
    
    for (int i = 0; i < count; i++) {
        std::string new_rtsp = gtk_editable_get_text(GTK_EDITABLE(state->url_entries[i]));
        if (new_rtsp.empty()) {
            gtk_label_set_text(GTK_LABEL(state->save_status), ("Stream " + std::to_string(i+1) + " URL cannot be empty").c_str());
            gtk_widget_add_css_class(state->save_status, "text-rose");
            return;
        }
        if (!std::regex_match(new_rtsp, url_regex)) {
            gtk_label_set_text(GTK_LABEL(state->save_status), ("Stream " + std::to_string(i+1) + " URL format invalid (e.g. rtsp://user:pass@ip:port/path)").c_str());
            gtk_widget_add_css_class(state->save_status, "text-rose");
            return;
        }
    }

    Config::getInstance().set("camera", "count", std::to_string(count));
    
    bool changed_rtsp = false;
    std::string user_db = App::getInstance().getCurrentDbName();
    for (int i = 0; i < count; i++) {
        std::string new_rtsp = gtk_editable_get_text(GTK_EDITABLE(state->url_entries[i]));
        std::string key = "rtsp_url_" + std::to_string(i);
        std::string old_rtsp = Config::getInstance().get("camera", key, "");
        if (new_rtsp != old_rtsp) {
            changed_rtsp = true;
        }
        // Always sync to DB (upsert) — handles both updates and new stream inserts
        // We now allow empty URLs to be saved so placeholders appear correctly
        if (!user_db.empty()) {
            MongoClient::getInstance().updateStreamUrl(user_db, i, new_rtsp);
        }
        Config::getInstance().set("camera", key, new_rtsp);
    }
    
    // Clean up any extra streams if count was reduced
    if (!user_db.empty()) {
        MongoClient::getInstance().deleteExcessStreams(user_db, count);
    }
    for (int i = count; i < 20; i++) {
        std::string key = "rtsp_url_" + std::to_string(i);
        Config::getInstance().remove("camera", key);
    }

    if (changed_rtsp) {
        LOG_AUTH(WARN, "auth.config", "AUTH-031", "RTSP URLs changed and synced to database");
    }

    std::string new_retention = gtk_editable_get_text(GTK_EDITABLE(state->e_cleanup));
    std::string old_retention = Config::getInstance().get("data", "cleanup_days", "30");
    if (new_retention != old_retention) {
        LOG_AUTH(INFO, "auth.config", "AUTH-033", "Retention policy changed");
    }

    Config::getInstance().set("data", "cleanup_days", new_retention);

    int limit = gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(state->e_limit));
    Config::getInstance().set("ui", "recent_limit", std::to_string(limit));



    std::string enabled_events_str = "";
    for (const auto& pair : state->alarm_checkboxes) {
        if (gtk_check_button_get_active(GTK_CHECK_BUTTON(pair.second))) {
            if (!enabled_events_str.empty()) enabled_events_str += ";";
            enabled_events_str += pair.first;
        }
    }
    Config::getInstance().set("alarm", "enabled_events", enabled_events_str);
    MongoClient::getInstance().updateAlarmConfig(App::getInstance().getCurrentDbName(), enabled_events_str);

    Config::getInstance().save("config.ini");

    LOG_AUTH(INFO, "auth.config", "AUTH-030", "Configuration saved");

    // Send UDP signal to backend service to trigger a restart
    trigger_backend_restart();

    gtk_button_set_label(GTK_BUTTON(btn), "✓ Saved");
    g_timeout_add(2000, [](gpointer d) -> gboolean {
        gtk_button_set_label(GTK_BUTTON(d), "Apply Settings");
        return G_SOURCE_REMOVE;
    }, btn);
}

static void on_change_password(GtkWidget* btn, gpointer data) {
    SettingsState* state = static_cast<SettingsState*>(data);
    const char* old_p = gtk_editable_get_text(GTK_EDITABLE(state->sec_entries[0]));
    const char* new_p = gtk_editable_get_text(GTK_EDITABLE(state->sec_entries[1]));
    const char* conf_p = gtk_editable_get_text(GTK_EDITABLE(state->sec_entries[2]));

    gtk_widget_remove_css_class(state->sec_status, "text-rose");
    gtk_widget_remove_css_class(state->sec_status, "text-emerald");

    if (strlen(new_p) < 6) {
        gtk_label_set_text(GTK_LABEL(state->sec_status), "Password must be at least 6 characters");
        gtk_widget_add_css_class(state->sec_status, "text-rose");
        return;
    }
    if (strcmp(new_p, conf_p) != 0) {
        gtk_label_set_text(GTK_LABEL(state->sec_status), "Passwords do not match");
        gtk_widget_add_css_class(state->sec_status, "text-rose");
        return;
    }

    std::string user = App::getInstance().getCurrentUser();
    std::string verified_db = MongoClient::getInstance().authenticateUser(user, old_p);
    
    if (!verified_db.empty()) {
        MongoClient::getInstance().updateUserPassword(user, new_p);
        LOG_AUTH(INFO, "auth.password", "AUTH-020", "Password changed successfully");
        gtk_label_set_text(GTK_LABEL(state->sec_status), "✓ Password updated successfully");
        gtk_widget_add_css_class(state->sec_status, "text-emerald");
        // Clear fields
        gtk_editable_set_text(GTK_EDITABLE(state->sec_entries[0]), "");
        gtk_editable_set_text(GTK_EDITABLE(state->sec_entries[1]), "");
        gtk_editable_set_text(GTK_EDITABLE(state->sec_entries[2]), "");
    } else {
        LOG_AUTH(WARN, "auth.password", "AUTH-021", "Password change failed — wrong current password");
        gtk_label_set_text(GTK_LABEL(state->sec_status), "Current password is incorrect");
        gtk_widget_add_css_class(state->sec_status, "text-rose");
    }
}

static GtkWidget* make_section(const char* title, const char* subtitle) {
    GtkWidget* card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 16);
    gtk_widget_add_css_class(card, "card");

    GtkWidget* head = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2);
    GtkWidget* t = gtk_label_new(title);
    gtk_widget_add_css_class(t, "bold");
    gtk_widget_set_halign(t, GTK_ALIGN_START);
    gtk_box_append(GTK_BOX(head), t);

    if (subtitle) {
        GtkWidget* s = gtk_label_new(subtitle);
        gtk_widget_add_css_class(s, "text-dim");
        gtk_widget_set_halign(s, GTK_ALIGN_START);
        gtk_box_append(GTK_BOX(head), s);
    }
    gtk_box_append(GTK_BOX(card), head);
    gtk_box_append(GTK_BOX(card), gtk_separator_new(GTK_ORIENTATION_HORIZONTAL));
    return card;
}

static GtkWidget* make_field_row(const char* label, GtkWidget* widget) {
    GtkWidget* row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 12);
    GtkWidget* lbl = gtk_label_new(label);
    gtk_widget_set_size_request(lbl, 180, -1);
    gtk_widget_set_halign(lbl, GTK_ALIGN_START);
    gtk_widget_add_css_class(lbl, "field-label");
    gtk_box_append(GTK_BOX(row), lbl);
    gtk_widget_set_hexpand(widget, TRUE);
    gtk_box_append(GTK_BOX(row), widget);
    return row;
}

static void on_nav_clicked(GtkButton* btn, gpointer data) {
    SettingsState* state = static_cast<SettingsState*>(g_object_get_data(G_OBJECT(btn), "state"));
    GtkWidget* target_section = GTK_WIDGET(data);
    
    double x, y;
    if (gtk_widget_translate_coordinates(target_section, state->nav.page, 0, 0, &x, &y)) {
        GtkAdjustment* adj = gtk_scrolled_window_get_vadjustment(GTK_SCROLLED_WINDOW(state->nav.scroll));
        double val = y - 20; 
        if (val < 0) val = 0;
        gtk_adjustment_set_value(adj, val);
    }
}

static void on_scroll_value_changed(GtkAdjustment* adj, gpointer data) {
    SettingsState* state = static_cast<SettingsState*>(data);
    double scroll_y = gtk_adjustment_get_value(adj);
    double page_size = gtk_adjustment_get_page_size(adj);
    double upper = gtk_adjustment_get_upper(adj);
    double threshold = scroll_y + 100;

    GtkWidget* active_btn = nullptr;
    
    if (scroll_y + page_size >= upper - 5) {
        if (!state->nav.sections.empty()) {
            active_btn = state->nav.sections.back().second;
        }
    } else {
        for (auto it = state->nav.sections.rbegin(); it != state->nav.sections.rend(); ++it) {
            double x, y;
            if (gtk_widget_translate_coordinates(it->first, state->nav.page, 0, 0, &x, &y)) {
                if (threshold >= y) {
                    active_btn = it->second;
                    break;
                }
            }
        }
    }
    if (!active_btn && !state->nav.sections.empty()) {
        active_btn = state->nav.sections.front().second;
    }

    for (auto& pair : state->nav.sections) {
        if (pair.second == active_btn) {
            gtk_widget_add_css_class(pair.second, "active");
        } else {
            gtk_widget_remove_css_class(pair.second, "active");
        }
    }
}

static GtkWidget* make_nav_item(SettingsState* state, const char* label_text, GtkWidget* target_section) {
    GtkWidget* btn = gtk_button_new();
    gtk_widget_add_css_class(btn, "settings-nav-btn");
    g_object_set_data(G_OBJECT(btn), "state", state);
    
    GtkWidget* lbl = gtk_label_new(label_text);
    gtk_widget_set_halign(lbl, GTK_ALIGN_START);
    
    gtk_button_set_child(GTK_BUTTON(btn), lbl);
    g_signal_connect(btn, "clicked", G_CALLBACK(on_nav_clicked), target_section);
    
    state->nav.sections.push_back({target_section, btn});
    return btn;
}

static void rebuild_camera_urls(SettingsState* st, bool preserve_text) {
    int c = gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(st->spin_stream_count));
    std::vector<std::string> prev_texts;
    if (preserve_text) {
        for (auto entry : st->url_entries) {
            prev_texts.push_back(gtk_editable_get_text(GTK_EDITABLE(entry)));
        }
    }

    GtkWidget* child = gtk_widget_get_first_child(st->urls_box);
    while (child) {
        GtkWidget* next = gtk_widget_get_next_sibling(child);
        gtk_box_remove(GTK_BOX(st->urls_box), child);
        child = next;
    }
    st->url_entries.clear();
    for (int i = 0; i < c; i++) {
        GtkWidget* e = gtk_entry_new();
        gtk_entry_set_placeholder_text(GTK_ENTRY(e), "rtsp://...");
        std::string t = "";
        if (preserve_text && i < prev_texts.size()) {
            t = prev_texts[i];
        } else {
            std::string key = "rtsp_url_" + std::to_string(i);
            t = Config::getInstance().get("camera", key, "");

        }
        gtk_editable_set_text(GTK_EDITABLE(e), t.c_str());
        st->url_entries.push_back(e);
        std::string label = "STREAM " + std::to_string(i + 1) + " URL";
        gtk_box_append(GTK_BOX(st->urls_box), make_field_row(label.c_str(), e));
    }
}

GtkWidget* createSettingsPage() {
    SettingsState* state = new SettingsState();

    GtkWidget* root_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
    gtk_widget_set_halign(root_box, GTK_ALIGN_CENTER);

    GtkWidget* left_spacer = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);

    GtkWidget* scroll = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scroll), GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget* page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 20);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 20);
    gtk_widget_set_margin_bottom(page, 40);
    gtk_widget_set_halign(page, GTK_ALIGN_CENTER);
    gtk_widget_set_size_request(page, 680, -1);

    state->nav.scroll = scroll;
    state->nav.page = page;

    // Page header
    GtkWidget* header = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2);
    GtkWidget* title = gtk_label_new("Settings");
    gtk_widget_add_css_class(title, "page-title");
    gtk_widget_set_halign(title, GTK_ALIGN_START);
    GtkWidget* sub = gtk_label_new("Manage camera, storage, security, and display preferences");
    gtk_widget_add_css_class(sub, "page-subtitle");
    gtk_widget_set_halign(sub, GTK_ALIGN_START);
    gtk_box_append(GTK_BOX(header), title);
    gtk_box_append(GTK_BOX(header), sub);
    gtk_box_append(GTK_BOX(page), header);

    // ── Camera ──
    GtkWidget* cam = make_section("Camera Source", "Configure camera streams and RTSP URLs");
    
    GtkWidget* row_count = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 12);
    GtkWidget* lbl_count = gtk_label_new("NUMBER OF STREAMS");
    gtk_widget_set_size_request(lbl_count, 180, -1);
    gtk_widget_set_halign(lbl_count, GTK_ALIGN_START);
    gtk_widget_add_css_class(lbl_count, "field-label");
    gtk_box_append(GTK_BOX(row_count), lbl_count);
    
    state->spin_stream_count = gtk_spin_button_new_with_range(1, 9, 1);
    int stream_c = 1;
    try { stream_c = std::stoi(Config::getInstance().get("camera", "count", "1")); } catch (...) {}
    gtk_spin_button_set_value(GTK_SPIN_BUTTON(state->spin_stream_count), stream_c);
    gtk_widget_set_hexpand(state->spin_stream_count, TRUE);
    gtk_box_append(GTK_BOX(row_count), state->spin_stream_count);
    gtk_box_append(GTK_BOX(cam), row_count);

    state->urls_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_box_append(GTK_BOX(cam), state->urls_box);

    // We defer DB loading to the map signal
    rebuild_camera_urls(state, false);

    g_signal_connect_data(state->spin_stream_count, "value-changed", G_CALLBACK(+[](GtkWidget*, gpointer d) {
        rebuild_camera_urls(static_cast<SettingsState*>(d), true);
    }), state, NULL, (GConnectFlags)0);

    // cam section built

    // ── Security ──
    GtkWidget* sec = make_section("Security", "Change your login credentials");
    state->sec_entries[0] = gtk_password_entry_new();
    gtk_password_entry_set_show_peek_icon(GTK_PASSWORD_ENTRY(state->sec_entries[0]), TRUE);
    state->sec_entries[1] = gtk_password_entry_new();
    gtk_password_entry_set_show_peek_icon(GTK_PASSWORD_ENTRY(state->sec_entries[1]), TRUE);
    state->sec_entries[2] = gtk_password_entry_new();
    gtk_password_entry_set_show_peek_icon(GTK_PASSWORD_ENTRY(state->sec_entries[2]), TRUE);
    state->sec_status = gtk_label_new("");

    gtk_box_append(GTK_BOX(sec), make_field_row("CURRENT PASSWORD", state->sec_entries[0]));
    gtk_box_append(GTK_BOX(sec), make_field_row("NEW PASSWORD", state->sec_entries[1]));
    gtk_box_append(GTK_BOX(sec), make_field_row("CONFIRM", state->sec_entries[2]));
    gtk_box_append(GTK_BOX(sec), state->sec_status);

    GtkWidget* btn_pass = gtk_button_new_with_label("Update Password");
    gtk_widget_add_css_class(btn_pass, "btn-secondary");
    gtk_widget_set_halign(btn_pass, GTK_ALIGN_END);
    g_signal_connect(btn_pass, "clicked", G_CALLBACK(on_change_password), state);
    gtk_box_append(GTK_BOX(sec), btn_pass);
    // sec section built

    // ── Display ──
    GtkWidget* display = make_section("Display & Maintenance", "Retention and sidebar preferences");
    state->e_cleanup = gtk_entry_new();
    gtk_editable_set_text(GTK_EDITABLE(state->e_cleanup),
                         Config::getInstance().get("data", "cleanup_days", "30").c_str());
    state->e_limit = gtk_spin_button_new_with_range(5, 500, 1);
    int limit = 15;
    try { limit = std::stoi(Config::getInstance().get("ui", "recent_limit", "15")); } catch (...) {}
    gtk_spin_button_set_value(GTK_SPIN_BUTTON(state->e_limit), limit);

    gtk_box_append(GTK_BOX(display), make_field_row("RETENTION DAYS", state->e_cleanup));
    gtk_box_append(GTK_BOX(display), make_field_row("RECENT LIMIT", state->e_limit));
    // display section built



    // ── NVDS Analytics ──
    GtkWidget* nvds_sec = make_section("Analytics (ROI & Lines)", "Manage NVDS Analytics coordinates");
    GtkWidget* analytics_editor = createAnalyticsEditor();
    gtk_box_append(GTK_BOX(nvds_sec), analytics_editor);
    // nvds_sec section built

    // ── Alarm Settings ──
    GtkWidget* alarm_sec = make_section("Alarm Trigger Settings", "Select which event types should trigger the audio alarm");
    GtkWidget* chk_box_container = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_box_append(GTK_BOX(alarm_sec), chk_box_container);

    state->chk_box_container = chk_box_container;

    // Default event types for fast UI startup. Will be updated in map signal
    std::vector<std::string> event_types = {"roi_entry", "roi_exit", "roi_dwell", "line_cross", "intrusion", "fall_detection"};

    std::string enabled_events_cfg = Config::getInstance().get("alarm", "enabled_events", "");
    for (const auto& et : event_types) {
        GtkWidget* chk = gtk_check_button_new_with_label(et.c_str());
        
        // Determine checked state (default to true if no configuration exists, or check config)
        bool is_checked = false;
        if (enabled_events_cfg.empty()) {
            is_checked = true;
        } else {
            std::stringstream ss(enabled_events_cfg);
            std::string item;
            while (std::getline(ss, item, ';')) {
                if (item == et) {
                    is_checked = true;
                    break;
                }
            }
        }
        
        gtk_check_button_set_active(GTK_CHECK_BUTTON(chk), is_checked ? TRUE : FALSE);
        state->alarm_checkboxes.push_back({et, chk});
        gtk_box_append(GTK_BOX(chk_box_container), chk);
    }
    // alarm_sec section built

    // ── Layout Assembly ──
    gtk_box_append(GTK_BOX(page), nvds_sec);
    gtk_box_append(GTK_BOX(page), alarm_sec);
    gtk_box_append(GTK_BOX(page), cam);
    gtk_box_append(GTK_BOX(page), display);

    gtk_box_append(GTK_BOX(page), sec);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scroll), page);

    // Side nav
    GtkWidget* side_nav_wrapper = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_add_css_class(side_nav_wrapper, "settings-nav-wrapper");
    gtk_widget_set_valign(side_nav_wrapper, GTK_ALIGN_START);
    gtk_widget_set_margin_top(side_nav_wrapper, 20);
    
    state->nav.nav_box = side_nav_wrapper;
    
    gtk_box_append(GTK_BOX(side_nav_wrapper), make_nav_item(state, "Analytics", nvds_sec));
    gtk_box_append(GTK_BOX(side_nav_wrapper), make_nav_item(state, "Alarm Settings", alarm_sec));
    gtk_box_append(GTK_BOX(side_nav_wrapper), make_nav_item(state, "Camera Source", cam));
    gtk_box_append(GTK_BOX(side_nav_wrapper), make_nav_item(state, "Display & Maintenance", display));

    gtk_box_append(GTK_BOX(side_nav_wrapper), make_nav_item(state, "Security", sec));

    // ── Save Button ──
    GtkWidget* save_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_top(save_box, 24);

    state->save_status = gtk_label_new("");
    gtk_label_set_wrap(GTK_LABEL(state->save_status), TRUE);
    gtk_widget_set_halign(state->save_status, GTK_ALIGN_START);
    gtk_box_append(GTK_BOX(save_box), state->save_status);

    state->btn_save = gtk_button_new_with_label("Apply Settings");
    gtk_widget_add_css_class(state->btn_save, "btn-save");
    g_signal_connect(state->btn_save, "clicked", G_CALLBACK(on_save_settings), state);
    gtk_box_append(GTK_BOX(save_box), state->btn_save);

    gtk_box_append(GTK_BOX(side_nav_wrapper), save_box);

    gtk_widget_set_margin_start(side_nav_wrapper, 20);
    gtk_widget_set_margin_end(left_spacer, 20);

    GtkSizeGroup* sg = gtk_size_group_new(GTK_SIZE_GROUP_HORIZONTAL);
    gtk_size_group_add_widget(sg, left_spacer);
    gtk_size_group_add_widget(sg, side_nav_wrapper);
    g_object_unref(sg);

    gtk_box_append(GTK_BOX(root_box), left_spacer);
    gtk_box_append(GTK_BOX(root_box), scroll);
    gtk_box_append(GTK_BOX(root_box), side_nav_wrapper);

    GtkAdjustment* vadj = gtk_scrolled_window_get_vadjustment(GTK_SCROLLED_WINDOW(scroll));
    g_signal_connect(vadj, "value-changed", G_CALLBACK(on_scroll_value_changed), state);

    // Initial trigger to set active class
    on_scroll_value_changed(vadj, state);
    
    g_signal_connect(root_box, "map", G_CALLBACK(+[](GtkWidget*, gpointer d) {
        SettingsState* s = static_cast<SettingsState*>(d);
        std::string user_db = App::getInstance().getCurrentDbName();
        if (user_db.empty() || s->loaded_db_name == user_db) return;
        
        s->loaded_db_name = user_db;
        


        // 2. Update Camera URLs
        std::vector<MongoStream> mongo_streams = MongoClient::getInstance().getStreams(user_db);
        if (!mongo_streams.empty()) {
            int mc = (int)mongo_streams.size();
            Config::getInstance().set("camera", "count", std::to_string(mc));
            gtk_spin_button_set_value(GTK_SPIN_BUTTON(s->spin_stream_count), mc);
            for (int i = 0; i < mc; i++) {
                std::string key = "rtsp_url_" + std::to_string(i);
                Config::getInstance().set("camera", key, mongo_streams[i].rtsp_url);
            }
        }
        rebuild_camera_urls(s, false);

        // 3. Update Alarm Checkboxes
        std::vector<std::string> event_types = MongoClient::getInstance().getDistinctEventTypes(user_db);
        
        GtkWidget* child = gtk_widget_get_first_child(s->chk_box_container);
        while (child) {
            GtkWidget* next = gtk_widget_get_next_sibling(child);
            gtk_box_remove(GTK_BOX(s->chk_box_container), child);
            child = next;
        }
        s->alarm_checkboxes.clear();

        std::string fetched_alarm_cfg = MongoClient::getInstance().getAlarmConfig(user_db);
        if (!fetched_alarm_cfg.empty()) {
            Config::getInstance().set("alarm", "enabled_events", fetched_alarm_cfg);
        }
        
        // Ensure that DB-fetched stream and alarm updates sync permanently to disk
        Config::getInstance().save("config.ini");

        std::string enabled_events_cfg = Config::getInstance().get("alarm", "enabled_events", "");
        for (const auto& et : event_types) {
            GtkWidget* chk = gtk_check_button_new_with_label(et.c_str());
            bool is_checked = false;
            if (enabled_events_cfg.empty()) {
                is_checked = true;
            } else {
                std::stringstream ss(enabled_events_cfg);
                std::string item;
                while (std::getline(ss, item, ';')) {
                    if (item == et) {
                        is_checked = true;
                        break;
                    }
                }
            }
            gtk_check_button_set_active(GTK_CHECK_BUTTON(chk), is_checked ? TRUE : FALSE);
            s->alarm_checkboxes.push_back({et, chk});
            gtk_box_append(GTK_BOX(s->chk_box_container), chk);
        }
    }), state);

    g_object_set_data_full(G_OBJECT(root_box), "state", state,
                          [](gpointer d){ delete static_cast<SettingsState*>(d); });

    return root_box;
}
