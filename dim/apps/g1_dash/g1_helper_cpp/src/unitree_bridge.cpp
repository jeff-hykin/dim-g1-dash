#include "unitree_bridge.hpp"

#include <algorithm>
#include <cmath>

#include <unitree/idl/go2/WirelessController_.hpp>
#include <unitree/robot/b2/motion_switcher/motion_switcher_client.hpp>
#include <unitree/robot/channel/channel_factory.hpp>
#include <unitree/robot/channel/channel_publisher.hpp>
#include <unitree/robot/channel/channel_subscriber.hpp>
#include <unitree/robot/g1/loco/g1_loco_client.hpp>
#include <unitree/idl/hg/LowState_.hpp>

namespace g1 {

namespace {

using LowStateMsg = unitree_hg::msg::dds_::LowState_;
using WirelessMsg = unitree_go::msg::dds_::WirelessController_;
using LocoClient = unitree::robot::g1::LocoClient;
using MotionSwitcherClient = unitree::robot::b2::MotionSwitcherClient;
using LowStateSubscriber = unitree::robot::ChannelSubscriber<LowStateMsg>;
using WirelessPublisher = unitree::robot::ChannelPublisher<WirelessMsg>;

constexpr char kLowStateTopic[] = "rt/lowstate";
constexpr char kWirelessTopic[] = "rt/wirelesscontroller";
constexpr float kLocoTimeoutSec = 10.0f;
constexpr float kSwitcherTimeoutSec = 10.0f;
// Re-issue the held velocity at 20 Hz; each SetVelocity carries a slightly longer
// duration so a dropped tick doesn't stutter the gait.
constexpr auto kControlPeriod = std::chrono::milliseconds(50);
constexpr float kVelocityDurationSec = 0.5f;
// Don't flood the panel — one state line every 100 ms is plenty for a dashboard.
constexpr auto kStateEmitPeriod = std::chrono::milliseconds(100);
// Ignore held velocities older than this so a stalled panel can't run the robot
// away; the drive UI refreshes well within it.
constexpr auto kVelocityStaleAfter = std::chrono::milliseconds(400);
// Loco FSM / motion-mode poll cadence for {"type":"loco"} events.
constexpr auto kStatusPeriod = std::chrono::seconds(1);

// ── g1_stand constants (see dimos bin/g1_stand for the provenance) ───────────
// Controller equivalents: L2+B → damp (FSM 1), L2+Up → get-ready (FSM 4),
// R2+A → advanced balance (FSM 801 entering, 802 active).
constexpr int kFsmDamp = 1;
constexpr int kFsmGetReady = 4;
constexpr int kFsmBasicBalance = 200;
constexpr int kFsmAdvancedEntry = 801;
constexpr int kFsmAdvancedActive = 802;
// rt/wirelesscontroller key bits, as the physical remote sends them.
constexpr uint16_t kKeyR2 = 1u << 4;
constexpr uint16_t kKeyA = 1u << 8;
constexpr double kComboHoldSec = 1.5;
constexpr double kComboReleaseSec = 0.3;
constexpr int kComboRateHz = 20;
// The FSM ignores SetFsmId while a transition (e.g. leg straighten) is still in
// flight, so re-send until the reported id matches instead of sleeping.
constexpr auto kStepTimeout = std::chrono::seconds(15);
constexpr auto kStepPoll = std::chrono::seconds(1);
// Motion service to stand under. The default sport controller walks with a
// stompy gait; "ai" is the natural one.
constexpr char kMotionMode[] = "ai";
constexpr auto kModeTimeout = std::chrono::seconds(10);

int gait_to_balance_mode(const std::string& gait) {
    if (gait == "walk") return 1;
    if (gait == "run") return 2;
    return 0;  // "static"
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

    auto* switcher = new MotionSwitcherClient();
    switcher->SetTimeout(kSwitcherTimeoutSec);
    switcher->Init();
    motion_switcher_ = switcher;

    auto* wireless = new WirelessPublisher(kWirelessTopic);
    wireless->InitChannel();
    wireless_publisher_ = wireless;

    connected_.store(true);
    running_.store(true);
    control_thread_ = std::thread(&UnitreeBridge::control_loop, this);
    status_thread_ = std::thread(&UnitreeBridge::status_loop, this);
    protocol_.log("unitree bridge up on " + network_interface_);
    return true;
}

void UnitreeBridge::stop() {
    running_.store(false);
    sequence_abort_.store(true);
    if (control_thread_.joinable()) control_thread_.join();
    if (status_thread_.joinable()) status_thread_.join();
    if (sequence_thread_.joinable()) sequence_thread_.join();

    // Deliberately no Damp() here: collapsing a balanced robot because the
    // dashboard restarted would be worse than leaving the onboard controller in
    // charge. E-stop is an explicit user action.
    if (loco_client_) {
        delete static_cast<LocoClient*>(loco_client_);
        loco_client_ = nullptr;
    }
    if (motion_switcher_) {
        delete static_cast<MotionSwitcherClient*>(motion_switcher_);
        motion_switcher_ = nullptr;
    }
    if (wireless_publisher_) {
        delete static_cast<WirelessPublisher*>(wireless_publisher_);
        wireless_publisher_ = nullptr;
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

bool UnitreeBridge::command(const std::string& name, const std::string& gait) {
    if (!loco_client_) return false;
    auto* client = static_cast<LocoClient*>(loco_client_);

    // Engage sequences (translated from bin/g1_stand) run on their own thread.
    if (name == "stand" || name == "balance" || name == "advanced") {
        if (sequence_running_.load()) {
            protocol_.error("a sequence is already running (" + sequence_name_ + ")");
            return false;
        }
        set_velocity(0, 0, 0);
        if (sequence_thread_.joinable()) sequence_thread_.join();
        sequence_abort_.store(false);
        sequence_running_.store(true);
        sequence_name_ = name;
        sequence_thread_ = std::thread(&UnitreeBridge::run_sequence, this, name, gait);
        return true;
    }

    // One-shots would fight the sequence thread over the FSM; E-STOP aborts it.
    if (sequence_running_.load()) {
        protocol_.error("sequence '" + sequence_name_ + "' in progress — E-STOP to abort");
        return false;
    }

    // Any discrete posture cancels an in-progress drive so the two don't fight.
    if (name != "wavehand" && name != "shakehand") set_velocity(0, 0, 0);

    try {
        std::lock_guard<std::mutex> rpc_guard(rpc_mutex_);
        if (name == "damp") client->Damp();
        else if (name == "ready" || name == "standup") client->StandUp();
        else if (name == "squat") client->Squat();
        else if (name == "sit") client->Sit();
        else if (name == "zerotorque") client->ZeroTorque();
        else if (name == "balancestand") client->BalanceStand();
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
    sequence_abort_.store(true);
    set_velocity(0, 0, 0);
    if (!loco_client_) return;
    try {
        std::lock_guard<std::mutex> rpc_guard(rpc_mutex_);
        static_cast<LocoClient*>(loco_client_)->Damp();
    } catch (const std::exception& err) {
        protocol_.error(std::string("estop damp failed: ") + err.what());
    }
    std::lock_guard<std::mutex> guard(mode_mutex_);
    mode_ = "damp";
}

// ── g1_stand sequence machinery ───────────────────────────────────────────────

int UnitreeBridge::query_fsm_id() {
    int fsm_id = -1;
    std::lock_guard<std::mutex> guard(rpc_mutex_);
    if (static_cast<LocoClient*>(loco_client_)->GetFsmId(fsm_id) != 0) return -1;
    return fsm_id;
}

std::string UnitreeBridge::query_motion_mode() {
    std::string form, name;
    std::lock_guard<std::mutex> guard(rpc_mutex_);
    if (static_cast<MotionSwitcherClient*>(motion_switcher_)->CheckMode(form, name) != 0) {
        return "?";
    }
    return name.empty() ? "none" : name;
}

void UnitreeBridge::emit_seq(const std::string& step, const std::string& state) {
    protocol_.emit({
        {"type", "seq"},
        {"seq", sequence_name_},
        {"step", step},
        {"state", state},
        {"fsm", query_fsm_id()},
    });
}

// SetFsmId + re-poll until the loco service reports the id (it ignores requests
// mid-transition), exactly like bin/g1_stand's run_step.
bool UnitreeBridge::run_fsm_step(const std::string& step, int fsm_id) {
    emit_seq(step, "start");
    const auto deadline = std::chrono::steady_clock::now() + kStepTimeout;
    while (!aborted() && std::chrono::steady_clock::now() < deadline) {
        int code;
        {
            std::lock_guard<std::mutex> guard(rpc_mutex_);
            code = static_cast<LocoClient*>(loco_client_)->SetFsmId(fsm_id);
        }
        if (code != 0) {
            protocol_.error(step + ": SetFsmId(" + std::to_string(fsm_id) +
                            ") failed (code=" + std::to_string(code) + ")");
            emit_seq(step, "failed");
            return false;
        }
        std::this_thread::sleep_for(kStepPoll);
        if (query_fsm_id() == fsm_id) {
            emit_seq(step, "ok");
            return true;
        }
    }
    emit_seq(step, aborted() ? "aborted" : "timeout");
    return false;
}

void UnitreeBridge::press_combo(uint16_t keys, double seconds) {
    auto* wireless = static_cast<WirelessPublisher*>(wireless_publisher_);
    const auto tick = std::chrono::milliseconds(1000 / kComboRateHz);
    const int ticks = static_cast<int>(seconds * kComboRateHz);
    for (int i = 0; i < ticks && !aborted(); ++i) {
        wireless->Write(WirelessMsg(0.0f, 0.0f, 0.0f, 0.0f, keys));
        std::this_thread::sleep_for(tick);
    }
}

// The advanced controller can ONLY be entered the way the physical remote does
// it: a held R2+A on rt/wirelesscontroller. SetFsmId(801) is silently refused.
bool UnitreeBridge::engage_advanced() {
    emit_seq("advanced", "start");
    const auto deadline = std::chrono::steady_clock::now() + kStepTimeout;
    while (!aborted() && std::chrono::steady_clock::now() < deadline) {
        press_combo(kKeyR2 | kKeyA, kComboHoldSec);
        press_combo(0, kComboReleaseSec);
        std::this_thread::sleep_for(kStepPoll);
        const int fsm = query_fsm_id();
        if (fsm == kFsmAdvancedEntry || fsm == kFsmAdvancedActive) {
            emit_seq("advanced", "ok");
            return true;
        }
    }
    emit_seq("advanced", aborted() ? "aborted" : "timeout");
    return false;
}

// Make the "ai" motion service resident. Controllers may only be switched while
// damped; with no mode resident there is no loco server to accept the damp
// (motors are already passive), so the damp is skipped.
bool UnitreeBridge::ensure_ai_mode() {
    std::string mode = query_motion_mode();
    if (mode == kMotionMode) return true;
    emit_seq("motion_mode", "start");
    if (mode != "none" && mode != "?" && !run_fsm_step("damp", kFsmDamp)) return false;
    int code;
    {
        std::lock_guard<std::mutex> guard(rpc_mutex_);
        code = static_cast<MotionSwitcherClient*>(motion_switcher_)->SelectMode(kMotionMode);
    }
    if (code != 0) {
        protocol_.error(std::string("SelectMode('") + kMotionMode +
                        "') failed (code=" + std::to_string(code) + ")");
        emit_seq("motion_mode", "failed");
        return false;
    }
    const auto deadline = std::chrono::steady_clock::now() + kModeTimeout;
    while (!aborted() && std::chrono::steady_clock::now() < deadline) {
        if (query_motion_mode() == kMotionMode) {
            emit_seq("motion_mode", "ok");
            return true;
        }
        std::this_thread::sleep_for(kStepPoll);
    }
    emit_seq("motion_mode", aborted() ? "aborted" : "timeout");
    return false;
}

bool UnitreeBridge::set_gait(const std::string& gait) {
    const int balance_mode = gait_to_balance_mode(gait);
    emit_seq("gait_" + gait, "start");
    const auto deadline = std::chrono::steady_clock::now() + kStepTimeout;
    while (!aborted() && std::chrono::steady_clock::now() < deadline) {
        int code;
        {
            std::lock_guard<std::mutex> guard(rpc_mutex_);
            code = static_cast<LocoClient*>(loco_client_)->SetBalanceMode(balance_mode);
        }
        if (code != 0) {
            protocol_.error("SetBalanceMode(" + std::to_string(balance_mode) +
                            ") failed (code=" + std::to_string(code) + ")");
            emit_seq("gait_" + gait, "failed");
            return false;
        }
        std::this_thread::sleep_for(kStepPoll);
        int reported = -1;
        {
            std::lock_guard<std::mutex> guard(rpc_mutex_);
            if (static_cast<LocoClient*>(loco_client_)->GetBalanceMode(reported) != 0) reported = -1;
        }
        if (reported == balance_mode) {
            emit_seq("gait_" + gait, "ok");
            return true;
        }
    }
    emit_seq("gait_" + gait, aborted() ? "aborted" : "timeout");
    return false;
}

void UnitreeBridge::run_sequence(std::string name, std::string gait) {
    {
        std::lock_guard<std::mutex> guard(mode_mutex_);
        mode_ = "engaging";
    }
    bool ok = false;
    if (name == "advanced") {
        // Just the R2+A emulation, assuming the robot is already in get-ready.
        ok = engage_advanced();
    } else {
        // Full flows: ai mode → damp → ready → (advanced | FSM 200 + gait).
        ok = ensure_ai_mode() &&
             run_fsm_step("damp", kFsmDamp) &&
             run_fsm_step("ready", kFsmGetReady);
        if (ok && name == "stand") ok = engage_advanced();
        if (ok && name == "balance") {
            ok = run_fsm_step("balance", kFsmBasicBalance) && set_gait(gait);
        }
    }
    {
        std::lock_guard<std::mutex> guard(mode_mutex_);
        mode_ = ok ? (name == "balance" ? "balance" : "standing") : "unknown";
    }
    emit_seq("sequence", ok ? "done" : "failed");
    sequence_running_.store(false);
}

// ── background loops ──────────────────────────────────────────────────────────

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
        if (fresh && moving && loco_client_ && !sequence_running_.load()) {
            try {
                std::lock_guard<std::mutex> guard(rpc_mutex_);
                static_cast<LocoClient*>(loco_client_)->SetVelocity(
                    static_cast<float>(vx), static_cast<float>(vy),
                    static_cast<float>(omega), kVelocityDurationSec);
            } catch (const std::exception& err) {
                protocol_.error(std::string("SetVelocity failed: ") + err.what());
            }
        }
        std::this_thread::sleep_for(kControlPeriod);
    }
}

void UnitreeBridge::status_loop() {
    while (running_.load()) {
        std::string mode;
        { std::lock_guard<std::mutex> guard(mode_mutex_); mode = mode_; }
        protocol_.emit({
            {"type", "loco"},
            {"fsm", query_fsm_id()},
            {"motionMode", query_motion_mode()},
            {"seqRunning", sequence_running_.load()},
            {"mode", mode},
        });
        std::this_thread::sleep_for(kStatusPeriod);
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

    std::string mode;
    { std::lock_guard<std::mutex> guard(mode_mutex_); mode = mode_; }

    // Note: the G1 hg LowState_ carries no battery/BMS field, so telemetry is
    // IMU + joint heat + FSM state. (A battery gauge would need a separate BMS
    // topic that isn't part of rt/lowstate.)
    protocol_.emit({
        {"type", "state"},
        {"rpy", {rpy[0], rpy[1], rpy[2]}},
        {"gyro", {imu.gyroscope()[0], imu.gyroscope()[1], imu.gyroscope()[2]}},
        {"accel", {imu.accelerometer()[0], imu.accelerometer()[1], imu.accelerometer()[2]}},
        {"hottestJoint", hottest_index},
        {"hottestTemp", hottest_temp},
        {"motorCount", static_cast<int>(motors.size())},
        {"fsmMachine", static_cast<int>(state.mode_machine())},
        {"fsmPr", static_cast<int>(state.mode_pr())},
        {"tick", static_cast<uint32_t>(state.tick())},
        {"mode", mode},
    });
}

}  // namespace g1
