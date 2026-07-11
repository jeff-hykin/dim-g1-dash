#include "unitree_bridge.hpp"

#include <algorithm>
#include <array>
#include <cmath>

#include <unitree/robot/channel/channel_factory.hpp>
#include <unitree/robot/channel/channel_subscriber.hpp>
#include <unitree/robot/g1/loco/g1_loco_client.hpp>
#include <unitree/idl/hg/LowState_.hpp>

namespace g1 {

namespace {

using LowStateMsg = unitree_hg::msg::dds_::LowState_;
using LocoClient = unitree::robot::g1::LocoClient;
using LowStateSubscriber = unitree::robot::ChannelSubscriber<LowStateMsg>;

constexpr char kLowStateTopic[] = "rt/lowstate";
constexpr float kLocoTimeoutSec = 10.0f;
// Re-issue the held velocity at 20 Hz; each SetVelocity carries a slightly longer
// duration so a dropped tick doesn't stutter the gait.
constexpr auto kControlPeriod = std::chrono::milliseconds(50);
constexpr float kVelocityDurationSec = 0.5f;
// Don't flood the panel — one state line every 100 ms is plenty for a dashboard.
constexpr auto kStateEmitPeriod = std::chrono::milliseconds(100);
// Ignore held velocities older than this so a stalled panel can't run the robot
// away; the drive UI refreshes well within it.
constexpr auto kVelocityStaleAfter = std::chrono::milliseconds(400);

// Cheap 2-cell LiPo-ish percentage estimate from pack voltage. The G1 pack is
// nominally ~50 V (13S); clamp to a sane 0..1 for the battery gauge.
constexpr double kPackFullVolts = 58.0;
constexpr double kPackEmptyVolts = 42.0;

double voltage_to_percent(double volts) {
    if (volts <= 0.0) return -1.0;  // unknown
    const double span = kPackFullVolts - kPackEmptyVolts;
    return std::clamp((volts - kPackEmptyVolts) / span, 0.0, 1.0);
}

}  // namespace

UnitreeBridge::UnitreeBridge(Protocol& protocol, std::string network_interface)
    : protocol_(protocol), network_interface_(std::move(network_interface)) {}

UnitreeBridge::~UnitreeBridge() { stop(); }

bool UnitreeBridge::start() {
    try {
        unitree::robot::ChannelFactory::Instance()->Init(0, network_interface_);
    } catch (const std::exception& err) {
        protocol_.error(std::string("unitree DDS init failed: ") + err.what());
        return false;
    }

    auto* subscriber = new LowStateSubscriber(kLowStateTopic);
    subscriber->InitChannel(
        [this](const void* message) { on_low_state(message); }, 1);
    low_state_subscriber_ = subscriber;

    auto* client = new LocoClient();
    client->Init();
    client->SetTimeout(kLocoTimeoutSec);
    loco_client_ = client;

    connected_.store(true);
    running_.store(true);
    control_thread_ = std::thread(&UnitreeBridge::control_loop, this);
    protocol_.log("unitree bridge up on " + network_interface_);
    return true;
}

void UnitreeBridge::stop() {
    running_.store(false);
    if (control_thread_.joinable()) control_thread_.join();

    if (loco_client_) {
        auto* client = static_cast<LocoClient*>(loco_client_);
        try { client->Damp(); } catch (...) { /* best effort on teardown */ }
        delete client;
        loco_client_ = nullptr;
    }
    if (low_state_subscriber_) {
        delete static_cast<LowStateSubscriber*>(low_state_subscriber_);
        low_state_subscriber_ = nullptr;
    }
    connected_.store(false);
}

void UnitreeBridge::set_velocity(double vx, double vy, double omega) {
    std::lock_guard<std::mutex> guard(velocity_mutex_);
    vx_ = vx;
    vy_ = vy;
    omega_ = omega;
    last_velocity_cmd_ = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> mode_guard(mode_mutex_);
    const bool moving = std::abs(vx) + std::abs(vy) + std::abs(omega) > 1e-3;
    if (moving) mode_ = "walking";
}

bool UnitreeBridge::command(const std::string& name) {
    if (!loco_client_) return false;
    auto* client = static_cast<LocoClient*>(loco_client_);

    // Any discrete gait cancels an in-progress drive so the two don't fight.
    if (name != "wavehand" && name != "shakehand") set_velocity(0, 0, 0);

    try {
        if (name == "damp") client->Damp();
        else if (name == "start") client->Start();
        else if (name == "standup") client->StandUp();
        else if (name == "squat2standup") client->Squat2StandUp();
        else if (name == "lie2standup") client->Lie2StandUp();
        else if (name == "sit") client->Sit();
        else if (name == "zerotorque") client->ZeroTorque();
        else if (name == "balancestand") client->BalanceStand(0);
        else if (name == "highstand") client->HighStand();
        else if (name == "lowstand") client->LowStand();
        else if (name == "wavehand") client->WaveHand(false);
        else if (name == "shakehand") client->ShakeHand();
        else return false;
    } catch (const std::exception& err) {
        protocol_.error(std::string("command '") + name + "' failed: " + err.what());
        return false;
    }

    std::lock_guard<std::mutex> guard(mode_mutex_);
    mode_ = name;
    return true;
}

void UnitreeBridge::estop() {
    set_velocity(0, 0, 0);
    command("damp");
}

void UnitreeBridge::control_loop() {
    while (running_.load()) {
        double vx = 0, vy = 0, omega = 0;
        bool fresh = false;
        {
            std::lock_guard<std::mutex> guard(velocity_mutex_);
            const auto age = std::chrono::steady_clock::now() - last_velocity_cmd_;
            fresh = age < kVelocityStaleAfter;
            if (fresh) { vx = vx_; vy = vy_; omega = omega_; }
        }
        const bool moving = std::abs(vx) + std::abs(vy) + std::abs(omega) > 1e-3;
        if (fresh && moving && loco_client_) {
            auto* client = static_cast<LocoClient*>(loco_client_);
            try {
                client->SetVelocity(static_cast<float>(vx), static_cast<float>(vy),
                                    static_cast<float>(omega), kVelocityDurationSec);
            } catch (const std::exception& err) {
                protocol_.error(std::string("SetVelocity failed: ") + err.what());
            }
        }
        std::this_thread::sleep_for(kControlPeriod);
    }
}

void UnitreeBridge::on_low_state(const void* message) {
    const auto now = std::chrono::steady_clock::now();
    if (now - last_state_emit_ < kStateEmitPeriod) return;
    last_state_emit_ = now;

    const auto& state = *static_cast<const LowStateMsg*>(message);

    const auto& imu = state.imu_state();
    const auto& rpy = imu.rpy();  // float[3] roll, pitch, yaw (rad)

    // Peak joint temperature is the useful safety number for a dashboard; scan
    // all motors and report the hottest plus its index.
    int hottest_index = -1;
    double hottest_temp = -1.0;
    const auto& motors = state.motor_state();
    for (size_t i = 0; i < motors.size(); ++i) {
        const double temp = static_cast<double>(motors[i].temperature()[0]);
        if (temp > hottest_temp) { hottest_temp = temp; hottest_index = static_cast<int>(i); }
    }

    // Battery. These two accessors are the ones most likely to be renamed across
    // SDK tags; if a pin fails to compile, adjust them here.
    const double voltage = static_cast<double>(state.power_v());
    const double current = static_cast<double>(state.power_a());

    std::string mode;
    { std::lock_guard<std::mutex> guard(mode_mutex_); mode = mode_; }

    protocol_.emit({
        {"type", "state"},
        {"rpy", {rpy[0], rpy[1], rpy[2]}},
        {"gyro", {imu.gyroscope()[0], imu.gyroscope()[1], imu.gyroscope()[2]}},
        {"accel", {imu.accelerometer()[0], imu.accelerometer()[1], imu.accelerometer()[2]}},
        {"voltage", voltage},
        {"current", current},
        {"battery", voltage_to_percent(voltage)},
        {"hottestJoint", hottest_index},
        {"hottestTemp", hottest_temp},
        {"motorCount", static_cast<int>(motors.size())},
        {"mode", mode},
    });
}

}  // namespace g1
