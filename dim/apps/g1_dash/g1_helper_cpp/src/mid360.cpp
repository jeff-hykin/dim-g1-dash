#include "mid360.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <netinet/in.h>
#include <nlohmann/json.hpp>

#include "livox_lidar_api.h"
#include "livox_lidar_def.h"

namespace g1 {

namespace {

using json = nlohmann::json;

constexpr auto kEmitPeriod = std::chrono::milliseconds(200);  // 5 Hz cloud
// Keep the wire payload small: stride the raw stream, cap the buffer.
constexpr uint32_t kIngestStride = 4;
constexpr size_t kMaxPoints = 1500;
// Ignore returns closer than this (the robot's own body / mount).
constexpr float kSelfIgnoreMeters = 0.25f;
constexpr float kMmToMeters = 0.001f;
constexpr float kCmToMeters = 0.01f;

constexpr auto kInitRetryDelay = std::chrono::seconds(10);
// Stock MID360 address on a Unitree G1 (the robot LAN is 192.168.123.0/24).
constexpr char kDefaultLidarIp[] = "192.168.123.120";

std::string env_or(const char* key, const char* fallback) {
    const char* value = std::getenv(key);
    return value && *value ? std::string(value) : std::string(fallback);
}

// The host IP the lidar should stream to: the local address that shares the
// lidar's /24. Beats a hardcoded default that breaks on robots with a
// different LAN plan.
std::string detect_host_ip(const std::string& lidar_ip) {
    const auto last_dot = lidar_ip.rfind('.');
    if (last_dot == std::string::npos) return "";
    const std::string subnet_prefix = lidar_ip.substr(0, last_dot + 1);

    ifaddrs* interfaces = nullptr;
    if (getifaddrs(&interfaces) != 0) return "";
    std::string found;
    for (ifaddrs* entry = interfaces; entry; entry = entry->ifa_next) {
        if (!entry->ifa_addr || entry->ifa_addr->sa_family != AF_INET) continue;
        char address[INET_ADDRSTRLEN] = {};
        const auto* ipv4 = reinterpret_cast<const sockaddr_in*>(entry->ifa_addr);
        inet_ntop(AF_INET, &ipv4->sin_addr, address, sizeof(address));
        if (std::strncmp(address, subnet_prefix.c_str(), subnet_prefix.size()) == 0) {
            found = address;
            break;
        }
    }
    freeifaddrs(interfaces);
    return found;
}

Mid360* g_instance = nullptr;  // Livox callbacks are C function pointers, no user ptr on init.

// Decode one Livox packet into meters and hand the points to the reader.
void point_cloud_callback(uint32_t /*handle*/, const uint8_t /*dev_type*/,
                          LivoxLidarEthernetPacket* packet, void* /*client_data*/) {
    if (!g_instance || !packet) return;
    const uint32_t count = packet->dot_num;
    std::vector<float> xyz(static_cast<size_t>(count) * 3);

    if (packet->data_type == kLivoxLidarCartesianCoordinateHighData) {
        const auto* points = reinterpret_cast<const LivoxLidarCartesianHighRawPoint*>(packet->data);
        for (uint32_t i = 0; i < count; ++i) {
            xyz[i * 3 + 0] = points[i].x * kMmToMeters;
            xyz[i * 3 + 1] = points[i].y * kMmToMeters;
            xyz[i * 3 + 2] = points[i].z * kMmToMeters;
        }
    } else if (packet->data_type == kLivoxLidarCartesianCoordinateLowData) {
        const auto* points = reinterpret_cast<const LivoxLidarCartesianLowRawPoint*>(packet->data);
        for (uint32_t i = 0; i < count; ++i) {
            xyz[i * 3 + 0] = points[i].x * kCmToMeters;
            xyz[i * 3 + 1] = points[i].y * kCmToMeters;
            xyz[i * 3 + 2] = points[i].z * kCmToMeters;
        }
    } else {
        return;  // spherical / imu packets — not used here
    }
    g_instance->ingest(xyz.data(), count);
}

}  // namespace

Mid360::Mid360(Protocol& protocol) : protocol_(protocol) {}

Mid360::~Mid360() { stop(); }

std::string Mid360::write_config_file() {
    const std::string lidar_ip = env_or("G1_LIDAR_IP", kDefaultLidarIp);
    std::string host_ip = env_or("G1_LIDAR_HOST_IP", "");
    if (host_ip.empty()) host_ip = detect_host_ip(lidar_ip);
    if (host_ip.empty()) {
        protocol_.error("mid360: no local interface on the lidar subnet (" + lidar_ip +
                        "/24) — set G1_LIDAR_HOST_IP / G1_LIDAR_IP");
        return "";
    }

    // MID360 config schema expected by Livox-SDK2. Host receives point/imu data
    // on the *_data_port entries; the lidar listens on its own fixed ports.
    json config = {
        {"MID360", {
            {"lidar_net_info", {
                {"cmd_data_port", 56100}, {"push_msg_port", 56200},
                {"point_data_port", 56300}, {"imu_data_port", 56400},
                {"log_data_port", 56500},
            }},
            {"host_net_info", {
                {"cmd_data_ip", host_ip}, {"cmd_data_port", 56101},
                {"push_msg_ip", host_ip}, {"push_msg_port", 56201},
                {"point_data_ip", host_ip}, {"point_data_port", 56301},
                {"imu_data_ip", host_ip}, {"imu_data_port", 56401},
                {"log_data_ip", ""}, {"log_data_port", 56501},
            }},
        }},
        {"lidar_configs", json::array({
            {{"ip", lidar_ip}, {"pcl_data_type", 1}, {"pattern_mode", 0}},
        })},
    };

    const std::string path = "/tmp/g1_mid360_config.json";
    std::FILE* file = std::fopen(path.c_str(), "w");
    if (!file) return "";
    const std::string text = config.dump(2);
    std::fwrite(text.data(), 1, text.size(), file);
    std::fclose(file);
    return path;
}

bool Mid360::start() {
    g_instance = this;
    running_.store(true);
    init_thread_ = std::thread(&Mid360::init_loop, this);
    emit_thread_ = std::thread(&Mid360::emit_loop, this);
    return true;
}

// Keep trying to claim the lidar. Init fails while another Livox client (e.g.
// a point-lio SLAM stack) holds the fixed UDP host ports; when it lets go, the
// next attempt succeeds and we flip the panel's lidar status.
void Mid360::init_loop() {
    bool blocked_reported = false;
    while (running_.load() && !connected_.load()) {
        const std::string config_path = write_config_file();
        if (config_path.empty()) return;
        if (LivoxLidarSdkInit(config_path.c_str())) {
            SetLivoxLidarPointCloudCallBack(point_cloud_callback, nullptr);
            LivoxLidarSdkStart();
            connected_.store(true);
            protocol_.log("mid360 lidar up");
            protocol_.emit({{"type", "status"}, {"lidar", true}});
            return;
        }
        LivoxLidarSdkUninit();  // clear any half-initialized SDK state before retrying
        if (!blocked_reported) {
            blocked_reported = true;
            protocol_.error(
                "mid360: cannot claim the lidar — its Livox UDP ports are in use "
                "(another client, e.g. point-lio, owns the MID360). Retrying quietly.");
        }
        for (int waited = 0; waited < kInitRetryDelay / std::chrono::seconds(1) &&
                             running_.load(); ++waited) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    }
}

void Mid360::stop() {
    running_.store(false);
    if (init_thread_.joinable()) init_thread_.join();
    if (emit_thread_.joinable()) emit_thread_.join();
    if (connected_.exchange(false)) {
        LivoxLidarSdkUninit();
    }
    g_instance = nullptr;
}

void Mid360::ingest(const float* xyz, uint32_t point_count) {
    std::lock_guard<std::mutex> guard(points_mutex_);
    total_ingested_ += point_count;
    for (uint32_t i = 0; i < point_count; i += kIngestStride) {
        const float x = xyz[i * 3 + 0];
        const float y = xyz[i * 3 + 1];
        const float z = xyz[i * 3 + 2];
        const float planar = std::sqrt(x * x + y * y);
        if (planar > kSelfIgnoreMeters && (nearest_ < 0.0f || planar < nearest_)) {
            nearest_ = planar;
        }
        if (points_.size() < kMaxPoints) {
            points_.push_back({x, y, z});
        }
    }
}

void Mid360::emit_loop() {
    while (running_.load()) {
        std::this_thread::sleep_for(kEmitPeriod);
        if (!streaming_.load()) {
            std::lock_guard<std::mutex> guard(points_mutex_);
            points_.clear();
            nearest_ = -1.0f;
            total_ingested_ = 0;
            continue;
        }

        std::vector<std::array<float, 3>> cloud;
        float nearest;
        uint64_t total;
        {
            std::lock_guard<std::mutex> guard(points_mutex_);
            cloud.swap(points_);
            nearest = nearest_;
            total = total_ingested_;
            nearest_ = -1.0f;
            total_ingested_ = 0;
        }
        if (total == 0) continue;

        // Flatten to [x,y,z,x,y,z,...] — a flat array is much cheaper to JSON-encode
        // and to consume in the browser than an array of triples.
        std::vector<float> flat;
        flat.reserve(cloud.size() * 3);
        for (const auto& point : cloud) {
            flat.push_back(point[0]);
            flat.push_back(point[1]);
            flat.push_back(point[2]);
        }

        protocol_.emit({
            {"type", "lidar"},
            {"points", static_cast<uint64_t>(total)},
            {"shown", static_cast<uint64_t>(cloud.size())},
            {"nearest", nearest},
            {"cloud", flat},
        });
    }
}

}  // namespace g1
