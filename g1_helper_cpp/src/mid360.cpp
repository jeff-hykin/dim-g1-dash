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
// Keep the wire payload small: stride the raw stream, cap the accumulated cloud.
constexpr uint32_t kIngestStride = 4;
// One 200 ms slice of a MID360 sweep is too sparse to read, so accumulate a few
// seconds of slices into the emitted cloud.
constexpr auto kAccumulateWindow = std::chrono::seconds(4);
constexpr size_t kMaxAccumulatedPoints = 6000;
constexpr size_t kMaxPointsPerSlice =
    kMaxAccumulatedPoints / (kAccumulateWindow / kEmitPeriod);
// Snap coordinates to a cm grid before JSON-encoding — full float precision
// doubles the payload for no visual gain.
constexpr float kCloudGridPerMeter = 100.0f;
// Ignore returns closer than this (the robot's own body / mount).
constexpr float kSelfIgnoreMeters = 0.25f;
constexpr float kMmToMeters = 0.001f;
constexpr float kCmToMeters = 0.01f;

constexpr auto kInitRetryDelay = std::chrono::seconds(10);
constexpr auto kManagePoll = std::chrono::milliseconds(200);

std::string env_or(const char* key, const char* fallback) {
    const char* value = std::getenv(key);
    return value && *value ? std::string(value) : std::string(fallback);
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

namespace {

// Find the (address, interface) pair on the lidar's /24.
void find_on_robot_lan(const std::string& lidar_ip, std::string& address_out,
                       std::string& interface_out) {
    address_out.clear();
    interface_out.clear();
    const auto last_dot = lidar_ip.rfind('.');
    if (last_dot == std::string::npos) return;
    const std::string subnet_prefix = lidar_ip.substr(0, last_dot + 1);

    ifaddrs* interfaces = nullptr;
    if (getifaddrs(&interfaces) != 0) return;
    for (ifaddrs* entry = interfaces; entry; entry = entry->ifa_next) {
        if (!entry->ifa_addr || entry->ifa_addr->sa_family != AF_INET) continue;
        char address[INET_ADDRSTRLEN] = {};
        const auto* ipv4 = reinterpret_cast<const sockaddr_in*>(entry->ifa_addr);
        inet_ntop(AF_INET, &ipv4->sin_addr, address, sizeof(address));
        if (std::strncmp(address, subnet_prefix.c_str(), subnet_prefix.size()) == 0) {
            address_out = address;
            if (entry->ifa_name) interface_out = entry->ifa_name;
            break;
        }
    }
    freeifaddrs(interfaces);
}

}  // namespace

// The host IP the lidar should stream to: the local address that shares the
// lidar's /24. Beats a hardcoded default that breaks on robots with a
// different LAN plan.
std::string detect_host_ip(const std::string& lidar_ip) {
    std::string address, interface_name;
    find_on_robot_lan(lidar_ip, address, interface_name);
    return address;
}

std::string detect_robot_interface(const std::string& lidar_ip) {
    std::string address, interface_name;
    find_on_robot_lan(lidar_ip, address, interface_name);
    return interface_name;
}

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
    manage_thread_ = std::thread(&Mid360::manage_loop, this);
    emit_thread_ = std::thread(&Mid360::emit_loop, this);
    return true;
}

// Claim/release the lidar to follow desired_. Init fails while another Livox
// client (e.g. a point-lio SLAM stack) holds the fixed UDP host ports; when it
// lets go, the next attempt succeeds and we flip the panel's lidar status.
void Mid360::manage_loop() {
    bool blocked_reported = false;
    while (running_.load()) {
        const bool want = desired_.load();
        if (want && !connected_.load()) {
            const std::string config_path = write_config_file();
            if (config_path.empty()) return;  // config error already reported
            if (LivoxLidarSdkInit(config_path.c_str())) {
                SetLivoxLidarPointCloudCallBack(point_cloud_callback, nullptr);
                LivoxLidarSdkStart();
                connected_.store(true);
                blocked_reported = false;
                protocol_.log("mid360 lidar up");
                protocol_.emit({{"type", "status"}, {"lidar", true}, {"lidarWanted", true}});
            } else {
                LivoxLidarSdkUninit();  // clear any half-initialized SDK state
                if (!blocked_reported) {
                    blocked_reported = true;
                    protocol_.error(
                        "mid360: cannot claim the lidar — its Livox UDP ports are in use "
                        "(another client, e.g. point-lio, owns the MID360). Retrying quietly.");
                }
                const auto retry_at = std::chrono::steady_clock::now() + kInitRetryDelay;
                while (running_.load() && desired_.load() &&
                       std::chrono::steady_clock::now() < retry_at) {
                    std::this_thread::sleep_for(kManagePoll);
                }
            }
        } else if (!want && connected_.load()) {
            LivoxLidarSdkUninit();
            connected_.store(false);
            protocol_.log("mid360 released");
            protocol_.emit({{"type", "status"}, {"lidar", false}, {"lidarWanted", false}});
        } else {
            std::this_thread::sleep_for(kManagePoll);
        }
    }
}

void Mid360::stop() {
    running_.store(false);
    if (manage_thread_.joinable()) manage_thread_.join();
    if (emit_thread_.joinable()) emit_thread_.join();
    if (connected_.exchange(false)) {
        LivoxLidarSdkUninit();
    }
    g_instance = nullptr;
}

void Mid360::ingest(const float* xyz, uint32_t point_count) {
    if (!connected_.load() || !desired_.load()) return;
    std::lock_guard<std::mutex> guard(points_mutex_);
    total_ingested_ += point_count;
    for (uint32_t i = 0; i < point_count; i += kIngestStride) {
        // The MID360 is mounted upside down — undo the 180° roll so the cloud
        // renders right side up (x stays forward, y and z negate).
        const float x = xyz[i * 3 + 0];
        const float y = -xyz[i * 3 + 1];
        const float z = -xyz[i * 3 + 2];
        const float planar = std::sqrt(x * x + y * y);
        if (planar > kSelfIgnoreMeters && (nearest_ < 0.0f || planar < nearest_)) {
            nearest_ = planar;
        }
        if (points_.size() < kMaxPointsPerSlice) {
            points_.push_back({x, y, z});
        }
    }
}

void Mid360::emit_loop() {
    while (running_.load()) {
        std::this_thread::sleep_for(kEmitPeriod);

        std::vector<std::array<float, 3>> slice;
        float nearest;
        uint64_t total;
        {
            std::lock_guard<std::mutex> guard(points_mutex_);
            slice.swap(points_);
            nearest = nearest_;
            total = total_ingested_;
            nearest_ = -1.0f;
            total_ingested_ = 0;
        }

        const auto now = std::chrono::steady_clock::now();
        if (!desired_.load()) {
            history_.clear();
        } else if (!slice.empty()) {
            history_.push_back({now, std::move(slice)});
        }
        while (!history_.empty() && now - history_.front().stamp > kAccumulateWindow) {
            history_.pop_front();
        }

        size_t accumulated = 0;
        for (const auto& entry : history_) accumulated += entry.points.size();
        if (accumulated == 0 && !cloud_on_screen_) continue;
        cloud_on_screen_ = accumulated > 0;

        // Flatten to [x,y,z,x,y,z,...] — a flat array is much cheaper to JSON-encode
        // and to consume in the browser than an array of triples.
        std::vector<float> flat;
        flat.reserve(accumulated * 3);
        for (const auto& entry : history_) {
            for (const auto& point : entry.points) {
                flat.push_back(std::round(point[0] * kCloudGridPerMeter) / kCloudGridPerMeter);
                flat.push_back(std::round(point[1] * kCloudGridPerMeter) / kCloudGridPerMeter);
                flat.push_back(std::round(point[2] * kCloudGridPerMeter) / kCloudGridPerMeter);
            }
        }

        protocol_.emit({
            {"type", "lidar"},
            {"points", static_cast<uint64_t>(total)},
            {"shown", static_cast<uint64_t>(accumulated)},
            {"nearest", nearest},
            {"cloud", flat},
        });
    }
}

}  // namespace g1
