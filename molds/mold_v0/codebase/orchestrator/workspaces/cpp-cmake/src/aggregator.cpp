#include "aggregator.hpp"

#include <algorithm>
#include <sstream>

bool Aggregator::ingest_line(const std::string& line) {
    std::stringstream ss(line);
    std::string id, ts, value;
    if (!std::getline(ss, id, ',') || !std::getline(ss, ts, ',') || !std::getline(ss, value)) return false;
    try {
        add(Reading{id, std::stoll(ts), std::stod(value)});
    } catch (...) {
        return false;
    }
    return !id.empty();
}

void Aggregator::add(const Reading& r) { by_sensor_[r.sensor_id].push_back(r); }

std::optional<Summary> Aggregator::summary(const std::string& sensor_id) const {
    auto it = by_sensor_.find(sensor_id);
    if (it == by_sensor_.end() || it->second.empty()) return std::nullopt;
    Summary s;
    s.count = it->second.size();
    s.min = s.max = it->second.front().value;
    double total = 0;
    for (const auto& r : it->second) {
        s.min = std::min(s.min, r.value);
        s.max = std::max(s.max, r.value);
        total += r.value;
    }
    s.mean = total / static_cast<double>(s.count);
    return s;
}

std::vector<std::string> Aggregator::sensors() const {
    std::vector<std::string> out;
    for (const auto& [id, _] : by_sensor_) out.push_back(id);
    return out;
}
