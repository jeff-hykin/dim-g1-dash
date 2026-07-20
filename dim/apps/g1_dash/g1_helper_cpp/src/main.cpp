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

    // DDS talks to the G1 over a network interface — argv[1] wins, else env, else eth0.
    const std::string network_interface =
        argc > 1 ? std::string(argv[1]) : env_or("G1_NET_IFACE", "eth0");

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
