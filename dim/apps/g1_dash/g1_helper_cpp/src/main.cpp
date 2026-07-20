// g1_helper — onboard C++ bridge for the Unitree G1.
//
// Brings up three sensor/control subsystems and multiplexes them over the stdio
// JSON-line protocol the Deno backend speaks:
//   * UnitreeBridge — G1 state + locomotion control (unitree_sdk2, DDS)
//   * Mid360        — MID360 lidar point cloud (Livox-SDK2)
//   * Webcam        — RealSense color node via plain V4L2, served as MJPEG video
//
// Each subsystem starts independently; a failure in one (e.g. no camera plugged
// in) is reported in the status event and the rest still run. Commands arrive on
// stdin, one JSON object per line.
//
// Safety: if this process dies, the robot stops on its own — the control loop only
// re-issues a velocity while fresh commands keep arriving (see kVelocityStaleAfter
// in unitree_bridge.cpp), so a dropped pipe halts motion within ~0.4 s.

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

#include <unistd.h>

#include <nlohmann/json.hpp>

#include "mid360.hpp"
#include "protocol.hpp"
#include "unitree_bridge.hpp"
#include "webcam.hpp"

namespace {

using g1::json;

std::string env_or(const char* key, const char* fallback) {
    const char* value = std::getenv(key);
    return value && *value ? std::string(value) : std::string(fallback);
}

}  // namespace

int main(int argc, char** argv) {
    g1::Protocol protocol;

    // Can we see the robot LAN at all? (the /24 the lidar lives on —
    // 192.168.123.x on a stock G1). No interface there → the panel shows an
    // explainer instead of dead widgets. An interface there but no Jetson
    // markers → "remote" mode: a laptop plugged into the robot's LAN, where
    // DDS control, telemetry and the lidar all work (the camera stays on the
    // robot).
    const std::string lidar_ip = env_or("G1_LIDAR_IP", g1::kDefaultLidarIp);
    const bool onboard = !g1::detect_host_ip(lidar_ip).empty();
    const bool is_jetson = access("/etc/nv_tegra_release", F_OK) == 0;
    const bool remote = onboard && !is_jetson;
    if (!onboard) {
        protocol.log("no interface on the robot LAN (" + lidar_ip +
                     "/24) — G1 Dash is meant to run on the G1's onboard Jetson. "
                     "Custom network? Set G1_NET_IFACE / G1_LIDAR_IP.");
    }

    // DDS binds to a network interface — argv[1] wins, else env, else whichever
    // interface sits on the robot LAN (eth0 on the Jetson itself, but anything
    // on a remote laptop), else eth0.
    std::string network_interface =
        argc > 1 ? std::string(argv[1]) : env_or("G1_NET_IFACE", "");
    if (network_interface.empty()) network_interface = g1::detect_robot_interface(lidar_ip);
    if (network_interface.empty()) network_interface = "eth0";

    g1::UnitreeBridge unitree(protocol, network_interface);
    g1::Mid360 lidar(protocol);
    g1::Webcam camera(protocol);

    const bool unitree_ok = unitree.start();
    // Camera and lidar are exclusive-access devices, so neither is claimed until
    // the panel asks (config camera/lidar: true) — start() only spins up the
    // MJPEG server and the manager threads.
    lidar.start();
    camera.start();

    protocol.emit({
        {"type", "status"},
        {"onboard", onboard},
        {"remote", remote},
        {"unitree", unitree_ok},
        {"lidar", lidar.connected()},
        {"lidarWanted", lidar.enabled()},
        {"camera", camera.connected()},
        {"camWanted", camera.enabled()},
        {"camPort", camera.port()},
        {"iface", network_interface},
    });
    protocol.emit({{"type", "ready"}});

    // Command loop. Blocks on stdin; EOF (parent closed the pipe) ends the program.
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        json message;
        try {
            message = json::parse(line);
        } catch (const std::exception&) {
            continue;  // ignore malformed lines
        }
        const std::string type = message.value("type", "");

        if (type == "move") {
            unitree.set_velocity(message.value("vx", 0.0), message.value("vy", 0.0),
                                 message.value("omega", 0.0));
        } else if (type == "cmd") {
            // command() reports its own errors (refusal codes, sequences, unknowns)
            unitree.command(message.value("name", ""), message.value("gait", "static"));
        } else if (type == "estop") {
            unitree.estop();
        } else if (type == "config") {
            if (message.contains("camera")) camera.set_enabled(message["camera"].get<bool>());
            if (message.contains("lidar")) lidar.set_enabled(message["lidar"].get<bool>());
        }
    }

    // stdin closed — shut down, but never hang the exit: SDK teardowns (DDS,
    // Livox, a UVC open stuck on a resetting camera) can block indefinitely.
    std::thread([] {
        std::this_thread::sleep_for(std::chrono::seconds(5));
        std::_Exit(0);
    }).detach();
    camera.stop();
    lidar.stop();
    unitree.stop();
    return 0;
}
